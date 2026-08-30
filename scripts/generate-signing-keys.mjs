// generate-signing-keys.mjs
//
// Emits a fresh LTI tool signing-key configuration to stdout as a single-line
// JSON array with exactly one entry:
//
//   [{ "kid": "<uuid>", "privateKeyPkcs8Pem": "-----BEGIN PRIVATE KEY-----\n…", "status": "active" }]
//
// The shape matches `rawSigningKeyConfigArraySchema` in
// server/src/lti/signing-keys.ts. `status` is "active" (at most one active entry
// is allowed); rotate an old key to "previous" by hand when adding a new one.
//
// This file contains NO key material — it only generates a new RS256 key pair on
// each run. Nothing generated here should ever be committed.
//
// Seed Key Vault with it directly:
//
//   az keyvault secret set --vault-name "$KV" --name lti-tool-signing-keys-json \
//     --value "$(node scripts/generate-signing-keys.mjs)"
//
// Run from the repo root (root package.json has "type": "module" and hoists jose).

import { generateKeyPair, exportPKCS8 } from 'jose';
import { randomUUID } from 'node:crypto';
import { stdout } from 'node:process';

const { privateKey } = await generateKeyPair('RS256', {
  modulusLength: 2048,
  extractable: true,
});

const privateKeyPkcs8Pem = await exportPKCS8(privateKey);
const kid = randomUUID();

stdout.write(JSON.stringify([{ kid, privateKeyPkcs8Pem, status: 'active' }]));
