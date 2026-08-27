import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import { randomUUID } from 'node:crypto';

interface MockKeyEntry {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: Record<string, unknown>;
}

export interface MintTokenOverrides {
  iss?: string;
  aud?: string | string[];
  azp?: string;
  sub?: string;
  nonce?: string;
  exp?: number;
  iat?: number;
  nbf?: number;
  deploymentId?: string;
  version?: string;
  messageType?: string;
  contextId?: string | null;
  roles?: string[] | null;
  extraClaims?: Record<string, unknown>;
}

export interface MintTokenOptions {
  kid?: string;
  alg?: string;
}

export class MockCanvasPlatform {
  readonly issuer = 'https://mock-canvas.test';
  private keys = new Map<string, MockKeyEntry>();
  private app: FastifyInstance;
  private port = 0;

  constructor() {
    this.app = Fastify({ logger: false });
    this.app.get('/jwks', async () => ({ keys: [...this.keys.values()].map((k) => k.publicJwk) }));
  }

  async start(): Promise<void> {
    const address = await this.app.listen({ port: 0, host: '127.0.0.1' });
    this.port = Number(new URL(address).port);
    await this.publishNewKey('default-kid');
  }

  async stop(): Promise<void> {
    await this.app.close();
  }

  get jwksUri(): string {
    return `http://127.0.0.1:${this.port}/jwks`;
  }

  async publishNewKey(kid: string): Promise<void> {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
    const publicJwk = await exportJWK(publicKey);
    this.keys.set(kid, { kid, privateKey, publicJwk: { ...publicJwk, kid, use: 'sig', alg: 'RS256' } });
  }

  unpublishKey(kid: string): void {
    this.keys.delete(kid);
  }

  async mintIdToken(overrides: MintTokenOverrides = {}, options: MintTokenOptions = {}): Promise<string> {
    const kid = options.kid ?? 'default-kid';
    if (!this.keys.has(kid)) {
      await this.publishNewKey(kid);
    }
    const entry = this.keys.get(kid);
    if (!entry) {
      throw new Error(`mock-canvas: no key published for kid "${kid}"`);
    }

    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
      iss: overrides.iss ?? this.issuer,
      aud: overrides.aud ?? 'mock-client-id',
      sub: overrides.sub ?? 'mock-user-1',
      exp: overrides.exp ?? now + 3600,
      iat: overrides.iat ?? now,
      nonce: overrides.nonce ?? randomUUID(),
      'https://purl.imsglobal.org/spec/lti/claim/version': overrides.version ?? '1.3.0',
      'https://purl.imsglobal.org/spec/lti/claim/message_type': overrides.messageType ?? 'LtiResourceLinkRequest',
      'https://purl.imsglobal.org/spec/lti/claim/deployment_id': overrides.deploymentId ?? 'mock-deployment-1',
      name: 'Mock Instructor',
      ...overrides.extraClaims,
    };
    if (overrides.azp) payload.azp = overrides.azp;
    if (overrides.nbf !== undefined) payload.nbf = overrides.nbf;
    if (overrides.contextId !== null) {
      payload['https://purl.imsglobal.org/spec/lti/claim/context'] = {
        id: overrides.contextId ?? 'mock-course-1',
        label: 'MOCK101',
        title: 'Mock Course',
      };
    }
    if (overrides.roles !== null) {
      payload['https://purl.imsglobal.org/spec/lti/claim/roles'] = overrides.roles ?? [
        'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor',
      ];
    }

    const signed = await new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid }).sign(entry.privateKey);

    if (options.alg && options.alg !== 'RS256') {
      // The key is generated for RS256, so we always sign RS256 and then rewrite
      // ONLY the protected-header segment to advertise the requested `alg`. The
      // returned token therefore carries an RS256 signature under a deliberately
      // mismatched `alg` header. It exists solely to exercise verifyLaunch's
      // pre-signature algorithm-allowlist rejection (spec §13.2 / §45 case 16,
      // `unsupported_algorithm`) and is NOT a validly `options.alg`-signed token.
      // Note: `alg: 'none'` would likewise produce a header-only rewrite with a
      // signature segment still present (not a true unsecured JWT). No Phase 3
      // caller needs a genuine unsecured JWT; flag for later phases if one does.
      const [, encodedPayload, signature] = signed.split('.');
      const encodedHeader = Buffer.from(JSON.stringify({ alg: options.alg, kid })).toString('base64url');
      return `${encodedHeader}.${encodedPayload}.${signature}`;
    }

    return signed;
  }
}
