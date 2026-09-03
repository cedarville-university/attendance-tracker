// server/tests/security/csp.test.ts
import { describe, it, expect } from 'vitest';
import { buildCspDirectives } from '../../src/security/csp.js';

describe('buildCspDirectives', () => {
  it('locks down default/script/style/connect to self and denies object/base/frame-ancestors', () => {
    const d = buildCspDirectives('https://app.test', []);
    expect(d.defaultSrc).toEqual(["'self'"]);
    expect(d.scriptSrc).toEqual(["'self'"]);
    expect(d.styleSrc).toEqual(["'self'"]);
    expect(d.connectSrc).toEqual(["'self'"]);
    expect(d.objectSrc).toEqual(["'none'"]);
    expect(d.baseUri).toEqual(["'none'"]);
    expect(d.frameAncestors).toEqual(["'none'"]);
  });

  it('adds the configured Canvas OIDC origins to form-action after self', () => {
    const d = buildCspDirectives('https://app.test', ['https://canvas.test', 'https://canvas-beta.test']);
    expect(d.formAction).toEqual(["'self'", 'https://canvas.test', 'https://canvas-beta.test']);
  });

  it('removes upgrade-insecure-requests for an http base url, keeps helmet default for https', () => {
    expect(buildCspDirectives('http://localhost:3000', []).upgradeInsecureRequests).toBeNull();
    expect('upgradeInsecureRequests' in buildCspDirectives('https://app.test', [])).toBe(false);
  });
});
