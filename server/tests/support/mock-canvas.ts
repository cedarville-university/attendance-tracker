import fastifyFormbody from '@fastify/formbody';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import { randomUUID } from 'node:crypto';
import type { NrpsRawMember } from '../../src/lti/roster-config.js';

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

  // --- Phase 4: token endpoint + paginated NRPS ---
  private issuedTokens = new Set<string>();
  private expiredTokens = new Set<string>();
  private courseMembers = new Map<string, NrpsRawMember[]>();
  private rateLimitOnce = new Set<string>();
  private breakNextPage = new Set<string>();
  private nrpsPageSize = 50;

  constructor() {
    this.app = Fastify({ logger: false });
    this.app.register(fastifyFormbody);
    this.app.get('/jwks', async () => ({ keys: [...this.keys.values()].map((k) => k.publicJwk) }));

    this.app.post('/login/oauth2/token', async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, string>;
      if (
        body.grant_type !== 'client_credentials' ||
        body.client_assertion_type !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' ||
        !body.client_assertion
      ) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const token = `mock-access-token-${randomUUID()}`;
      this.issuedTokens.add(token);
      return { access_token: token, token_type: 'Bearer', expires_in: 3600, scope: body.scope ?? '' };
    });

    this.app.get('/nrps/:courseId/members', async (request, reply) => {
      const { courseId } = request.params as { courseId: string };
      const auth = request.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      if (!this.issuedTokens.has(token) || this.expiredTokens.has(token)) {
        return reply.code(401).send({ error: 'invalid_token' });
      }

      const page = Number((request.query as { page?: string }).page ?? '1');

      if (this.rateLimitOnce.has(courseId)) {
        this.rateLimitOnce.delete(courseId);
        reply.header('retry-after', '1');
        return reply.code(429).send({ error: 'rate_limited' });
      }

      if (this.breakNextPage.has(courseId) && page >= 2) {
        this.breakNextPage.delete(courseId);
        return { id: this.nrpsUrlFor(courseId), context: {} }; // deliberately no `members`
      }

      const all = this.courseMembers.get(courseId) ?? [];
      const start = (page - 1) * this.nrpsPageSize;
      const slice = all.slice(start, start + this.nrpsPageSize);
      if (start + this.nrpsPageSize < all.length) {
        reply.header('link', `<${this.nrpsUrlFor(courseId)}?page=${page + 1}>; rel="next"`);
      }
      return { id: this.nrpsUrlFor(courseId), context: {}, members: slice };
    });
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

  private get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get tokenUrl(): string {
    return `${this.baseUrl}/login/oauth2/token`;
  }

  nrpsUrlFor(courseId: string): string {
    return `${this.baseUrl}/nrps/${courseId}/members`;
  }

  setCourseMembers(courseId: string, members: NrpsRawMember[]): void {
    this.courseMembers.set(courseId, members);
  }
  setPageSize(n: number): void {
    this.nrpsPageSize = n;
  }
  expireAccessToken(token: string): void {
    this.expiredTokens.add(token);
  }
  rateLimitNextRequest(courseId: string): void {
    this.rateLimitOnce.add(courseId);
  }
  breakPaginationOnNextPage(courseId: string): void {
    this.breakNextPage.add(courseId);
  }
}
