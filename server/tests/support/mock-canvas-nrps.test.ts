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
      scope: 'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly',
    }).toString(),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

describe('MockCanvasPlatform NRPS/token extensions', () => {
  let platform: MockCanvasPlatform;
  beforeAll(async () => {
    platform = new MockCanvasPlatform();
    await platform.start();
  });
  afterAll(async () => {
    await platform.stop();
  });

  it('issues a token and serves paginated members with it', async () => {
    platform.setCourseMembers('c1', [
      { user_id: 'u1', status: 'Active', roles: [] },
      { user_id: 'u2', status: 'Active', roles: [] },
    ]);
    platform.setPageSize(1);
    const token = await mintToken(platform);

    const p1 = await fetch(platform.nrpsUrlFor('c1'), { headers: { authorization: `Bearer ${token}` } });
    expect(p1.status).toBe(200);
    expect(p1.headers.get('link')).toContain('page=2');
    expect(((await p1.json()) as { members: unknown[] }).members).toHaveLength(1);
  });

  it('rejects an unknown bearer token with 401', async () => {
    const res = await fetch(platform.nrpsUrlFor('c1'), { headers: { authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
  });
});
