// spec §22: a raw card code must not be persisted by default. If an
// institution needs a durable card reference for diagnostics, this HMAC
// fingerprint is what gets stored instead -- never the raw code. Treat the
// fingerprint itself as sensitive/pseudonymous data (it still lets you tell
// "same card scanned twice" apart from "different card"), just not as
// sensitive as the raw code.

import { createHmac } from 'node:crypto';

export function computeCardFingerprint(cardCode: string, secret: string): string {
  return createHmac('sha256', secret).update(cardCode, 'utf8').digest('hex');
}
