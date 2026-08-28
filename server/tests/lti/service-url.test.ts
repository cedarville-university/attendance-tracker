import { describe, it, expect } from 'vitest';
import { validateCanvasServiceUrl } from '../../src/lti/service-url.js';

describe('validateCanvasServiceUrl', () => {
  it("accepts an absolute https URL on the registration's Canvas host", () => {
    expect(
      validateCanvasServiceUrl('https://school.instructure.com/api/lti/courses/1/names_and_roles'),
    ).toEqual({ ok: true });
  });

  it('accepts an absolute http URL (the in-process mock Canvas serves plain http)', () => {
    expect(validateCanvasServiceUrl('http://127.0.0.1:54321/nrps/course-1/members')).toEqual({ ok: true });
  });

  it('rejects a non-http(s) scheme', () => {
    expect(validateCanvasServiceUrl('ftp://school.instructure.com/roster')).toEqual({
      ok: false,
      error: 'unsupported-scheme',
    });
  });

  it('rejects a URL with embedded credentials', () => {
    expect(validateCanvasServiceUrl('https://user:pass@school.instructure.com/roster')).toEqual({
      ok: false,
      error: 'embedded-credentials',
    });
  });

  it('rejects a malformed URL', () => {
    expect(validateCanvasServiceUrl('not a url')).toEqual({ ok: false, error: 'malformed-url' });
  });
});
