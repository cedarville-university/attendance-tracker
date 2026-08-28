import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MockCanvasPlatform } from './mock-canvas.js';

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

describe('MockCanvasPlatform AGS endpoints', () => {
  let platform: MockCanvasPlatform;
  beforeAll(async () => {
    platform = new MockCanvasPlatform();
    await platform.start();
  });
  afterAll(async () => {
    await platform.stop();
  });

  it('401s a line-items request with no valid bearer token', async () => {
    const res = await fetch(platform.lineItemsUrlFor('c1'), { headers: { authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
  });

  it('lists an empty collection, creates a line item, then lists + filters it by tag/resource_id', async () => {
    const token = await mintToken(platform);
    const authHeader = { authorization: `Bearer ${token}` };

    const empty = await fetch(platform.lineItemsUrlFor('c2'), { headers: authHeader });
    expect(await empty.json()).toEqual([]);

    const created = await fetch(platform.lineItemsUrlFor('c2'), {
      method: 'POST',
      headers: { ...authHeader, 'content-type': 'application/vnd.ims.lis.v2.lineitem+json' },
      body: JSON.stringify({ scoreMaximum: 100, label: 'Attendance', resourceId: 'attendance-cumulative-v1', tag: 'attendance' }),
    });
    const li = (await created.json()) as { id: string; resourceId: string; tag: string };
    expect(li.id).toMatch(/\/ags\/lineitems\//);
    expect(li.resourceId).toBe('attendance-cumulative-v1');

    const filtered = await fetch(`${platform.lineItemsUrlFor('c2')}?tag=attendance&resource_id=attendance-cumulative-v1`, { headers: authHeader });
    const list = (await filtered.json()) as unknown[];
    expect(list).toHaveLength(1);

    const noMatch = await fetch(`${platform.lineItemsUrlFor('c2')}?tag=nope`, { headers: authHeader });
    expect(await noMatch.json()).toEqual([]);
  });

  it('accepts a score POST to <lineItem>/scores and records it', async () => {
    const token = await mintToken(platform);
    const authHeader = { authorization: `Bearer ${token}` };
    const li = platform.seedExistingLineItem('c3');

    const res = await fetch(`${li}/scores`, {
      method: 'POST',
      headers: { ...authHeader, 'content-type': 'application/vnd.ims.lis.v1.score+json' },
      body: JSON.stringify({ userId: 'u1', scoreGiven: 87.5, scoreMaximum: 100, activityProgress: 'Completed', gradingProgress: 'FullyGraded', timestamp: new Date().toISOString() }),
    });
    expect(res.ok).toBe(true);
    const scores = platform.getPostedScores('c3');
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({ userId: 'u1', scoreGiven: 87.5 });
  });

  it('failNextAgsRequest("rate-limited") makes the NEXT AGS request a one-shot 429 with retry-after', async () => {
    const token = await mintToken(platform);
    platform.failNextAgsRequest('rate-limited');
    const res = await fetch(platform.lineItemsUrlFor('c4'), { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('1');
    // one-shot: the following request succeeds
    const ok = await fetch(platform.lineItemsUrlFor('c4'), { headers: { authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
  });

  it('failNextAgsRequest("client-error") -> one-shot 422; ("server-error") -> one-shot 500; ("auth") -> one-shot 401', async () => {
    const token = await mintToken(platform);
    platform.failNextAgsRequest('client-error');
    expect((await fetch(platform.lineItemsUrlFor('c5'), { headers: { authorization: `Bearer ${token}` } })).status).toBe(422);
    platform.failNextAgsRequest('server-error');
    expect((await fetch(platform.lineItemsUrlFor('c5'), { headers: { authorization: `Bearer ${token}` } })).status).toBe(500);
    platform.failNextAgsRequest('auth');
    expect((await fetch(platform.lineItemsUrlFor('c5'), { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    // one-shot: the token is still otherwise valid
    expect((await fetch(platform.lineItemsUrlFor('c5'), { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  it('failNextScorePost fails ONLY the next score POST, leaving the line-items GET/POST alone', async () => {
    const token = await mintToken(platform);
    const authHeader = { authorization: `Bearer ${token}` };
    const li = platform.seedExistingLineItem('c6');

    platform.failNextScorePost('rate-limited');
    // The line-items GET is untouched by the score-only injector.
    expect((await fetch(platform.lineItemsUrlFor('c6'), { headers: authHeader })).status).toBe(200);

    const postScore = () =>
      fetch(`${li}/scores`, {
        method: 'POST',
        headers: { ...authHeader, 'content-type': 'application/vnd.ims.lis.v1.score+json' },
        body: JSON.stringify({ userId: 'u1', scoreGiven: 10, scoreMaximum: 100, activityProgress: 'Completed', gradingProgress: 'FullyGraded', timestamp: new Date().toISOString() }),
      });
    const failed = await postScore();
    expect(failed.status).toBe(429);
    expect(failed.headers.get('retry-after')).toBe('1');
    expect((await postScore()).status).toBe(200); // one-shot
  });
});
