import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MockCanvasPlatform } from '../support/mock-canvas.js';
import { ensureLineItem, postScore, ATTENDANCE_RESOURCE_ID, ATTENDANCE_TAG } from '../../src/lti/ags.js';

async function mintToken(platform: MockCanvasPlatform): Promise<string> {
  const res = await fetch(platform.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: 'mock-assertion',
      scope: 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem https://purl.imsglobal.org/spec/lti-ags/scope/score',
    }).toString(),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

describe('ensureLineItem', () => {
  let platform: MockCanvasPlatform;
  beforeAll(async () => {
    platform = new MockCanvasPlatform();
    await platform.start();
  });
  afterAll(async () => {
    await platform.stop();
  });

  it('creates a line item when none exists, with the stable resourceId/tag/maximum', async () => {
    const token = await mintToken(platform);
    const result = await ensureLineItem(platform.lineItemsUrlFor('c-create'), token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.resourceId).toBe(ATTENDANCE_RESOURCE_ID);
      expect(result.value.tag).toBe(ATTENDANCE_TAG);
      expect(result.value.scoreMaximum).toBe(100);
      expect(result.value.canvasLineItemUrl).toMatch(/\/ags\/lineitems\//);
      expect(result.value.canvasLineItemId).not.toContain('/');
    }
    expect(platform.getLineItems('c-create')).toHaveLength(1);
  });

  it('reuses an existing matching line item instead of creating a second (idempotent)', async () => {
    const token = await mintToken(platform);
    platform.seedExistingLineItem('c-reuse');
    const result = await ensureLineItem(platform.lineItemsUrlFor('c-reuse'), token);
    expect(result.ok).toBe(true);
    expect(platform.getLineItems('c-reuse')).toHaveLength(1); // no new line item
  });

  it('classifies a 429 as retryable rate-limited with retryAfterSeconds', async () => {
    const token = await mintToken(platform);
    platform.failNextAgsRequest('rate-limited');
    const result = await ensureLineItem(platform.lineItemsUrlFor('c-429'), token);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('rate-limited');
      expect(result.error.retryable).toBe(true);
      expect(result.error.retryAfterSeconds).toBe(1);
    }
  });

  it('classifies a 500 as retryable server-error', async () => {
    const token = await mintToken(platform);
    platform.failNextAgsRequest('server-error');
    const result = await ensureLineItem(platform.lineItemsUrlFor('c-500'), token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ kind: 'server-error', retryable: true });
  });

  it('classifies a 422 as PERMANENT client-error (never retried)', async () => {
    const token = await mintToken(platform);
    platform.failNextAgsRequest('client-error');
    const result = await ensureLineItem(platform.lineItemsUrlFor('c-422'), token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ kind: 'client-error', retryable: false, status: 422 });
  });

  it('classifies a thrown fetch as retryable network', async () => {
    const dead: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await ensureLineItem('https://canvas.example.edu/api/lti/courses/1/line_items', 'tok', { fetchImpl: dead });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ kind: 'network', retryable: true });
  });

  it('rejects a malformed line-items URL without a fetch', async () => {
    const result = await ensureLineItem('not a url', 'tok');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid-service-url');
  });
});

describe('postScore', () => {
  let platform: MockCanvasPlatform;
  beforeAll(async () => {
    platform = new MockCanvasPlatform();
    await platform.start();
  });
  afterAll(async () => {
    await platform.stop();
  });

  it('posts to <lineItemUrl>/scores with Completed / FullyGraded and records the score', async () => {
    const token = await mintToken(platform);
    const lineItemUrl = platform.seedExistingLineItem('c-score');
    const result = await postScore(lineItemUrl, token, {
      userId: 'u1',
      scoreGiven: 94.5,
      scoreMaximum: 100,
      timestamp: '2026-08-28T12:00:00.123Z',
    });
    expect(result.ok).toBe(true);
    const scores = platform.getPostedScores('c-score');
    expect(scores[0]).toMatchObject({
      userId: 'u1',
      scoreGiven: 94.5,
      scoreMaximum: 100,
      activityProgress: 'Completed',
      gradingProgress: 'FullyGraded',
      timestamp: '2026-08-28T12:00:00.123Z',
    });
  });

  it('classifies a 429 on the score post as retryable rate-limited', async () => {
    const token = await mintToken(platform);
    const lineItemUrl = platform.seedExistingLineItem('c-score429');
    platform.failNextAgsRequest('rate-limited');
    const result = await postScore(lineItemUrl, token, { userId: 'u1', scoreGiven: 10, scoreMaximum: 100, timestamp: new Date().toISOString() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('rate-limited');
  });
});
