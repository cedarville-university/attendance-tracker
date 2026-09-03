// server/tests/security/same-origin.test.ts
import { describe, it, expect } from 'vitest';
import { assertSameOrigin } from '../../src/security/same-origin.js';

describe('assertSameOrigin', () => {
  it('passes when scheme, host and port all match', () => {
    expect(() =>
      assertSameOrigin('https://canvas.test/api/lti/courses/1/line_items/9', 'https://canvas.test/api/lti/courses/1/line_items'),
    ).not.toThrow();
  });

  it('throws same-origin:mismatch on a different host', () => {
    expect(() =>
      assertSameOrigin('https://evil.test/line_items/9', 'https://canvas.test/api/lti/courses/1/line_items'),
    ).toThrow('same-origin:mismatch');
  });

  it('throws same-origin:mismatch on a different port', () => {
    expect(() => assertSameOrigin('https://canvas.test:8443/x', 'https://canvas.test/x')).toThrow('same-origin:mismatch');
  });

  it('throws same-origin:mismatch on a different scheme', () => {
    expect(() => assertSameOrigin('http://canvas.test/x', 'https://canvas.test/x')).toThrow('same-origin:mismatch');
  });

  it('throws same-origin:unparseable when an argument is not an absolute URL', () => {
    expect(() => assertSameOrigin('/relative/path', 'https://canvas.test/x')).toThrow('same-origin:unparseable');
  });
});
