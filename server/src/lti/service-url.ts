//
// Structural sanity check for a Canvas-provided service URL (NRPS membership endpoint, AGS line-items
// endpoint). The URL comes only from a signature-verified LTI launch JWT and is persisted verbatim
// onto the courses row -- that provenance is the SSRF trust anchor (spec §31.7). This function does
// NOT rebuild a host allowlist. Redirect rejection happens at the fetch call site (`redirect:'manual'`).

export interface ServiceUrlValidationResult {
  ok: boolean;
  error?: 'malformed-url' | 'unsupported-scheme' | 'embedded-credentials';
}

export function validateCanvasServiceUrl(url: string): ServiceUrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'malformed-url' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: 'unsupported-scheme' };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, error: 'embedded-credentials' };
  }
  return { ok: true };
}
