import fastifyFormbody from '@fastify/formbody';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
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

  // --- Phase 6: AGS line items + scores ---
  private lineItems = new Map<string, Array<{ id: string; scoreMaximum: number; label: string; resourceId: string; tag: string }>>();
  private lineItemScores = new Map<string, Array<Record<string, unknown>>>(); // keyed by lineItemId (trailing segment)
  private agsFailOnce: 'rate-limited' | 'server-error' | 'client-error' | 'auth' | null = null;
  // Score-route-only one-shot, so a worker test can fail the score POST without failing
  // ensureLineItem's GET/POST in the same pass.
  private agsScoreFailOnce: 'rate-limited' | 'server-error' | 'client-error' | null = null;

  constructor() {
    this.app = Fastify({ logger: false });
    this.app.register(fastifyFormbody);

    // Canvas AGS requires vendor content types Fastify's default JSON parser ignores.
    this.app.addContentTypeParser(
      ['application/vnd.ims.lis.v2.lineitem+json', 'application/vnd.ims.lis.v1.score+json'],
      { parseAs: 'string' },
      (_req, body, done) => {
        try {
          done(null, body ? JSON.parse(body as string) : {});
        } catch (err) {
          done(err as Error);
        }
      },
    );

    const agsAuthOk = (request: FastifyRequest): boolean => {
      const auth = request.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      return this.issuedTokens.has(token) && !this.expiredTokens.has(token);
    };
    // Returns a reply if a one-shot failure is armed; caller returns it. Consumes the injection.
    const consumeAgsFailure = (reply: FastifyReply): FastifyReply | null => {
      const kind = this.agsFailOnce;
      if (!kind) return null;
      this.agsFailOnce = null;
      if (kind === 'rate-limited') {
        reply.header('retry-after', '1');
        return reply.code(429).send({ error: 'rate_limited' });
      }
      if (kind === 'server-error') return reply.code(500).send({ error: 'server_error' });
      if (kind === 'auth') return reply.code(401).send({ error: 'invalid_token' }); // one-shot revoked-token 401
      return reply.code(422).send({ error: 'unprocessable', errors: ['mock one-shot client error'] });
    };

    this.app.get('/ags/:courseId/lineitems', async (request, reply) => {
      if (!agsAuthOk(request)) return reply.code(401).send({ error: 'invalid_token' });
      const failure = consumeAgsFailure(reply);
      if (failure) return failure;
      const { courseId } = request.params as { courseId: string };
      const query = request.query as { tag?: string; resource_id?: string };
      let items = this.lineItems.get(courseId) ?? [];
      if (query.tag !== undefined) items = items.filter((li) => li.tag === query.tag);
      if (query.resource_id !== undefined) items = items.filter((li) => li.resourceId === query.resource_id);
      return items;
    });

    this.app.post('/ags/:courseId/lineitems', async (request, reply) => {
      if (!agsAuthOk(request)) return reply.code(401).send({ error: 'invalid_token' });
      const failure = consumeAgsFailure(reply);
      if (failure) return failure;
      const { courseId } = request.params as { courseId: string };
      const body = (request.body ?? {}) as Record<string, unknown>;
      const created = this.createLineItem(courseId, {
        scoreMaximum: typeof body.scoreMaximum === 'number' ? body.scoreMaximum : 100,
        label: typeof body.label === 'string' ? body.label : 'Attendance',
        resourceId: typeof body.resourceId === 'string' ? body.resourceId : 'attendance-cumulative-v1',
        tag: typeof body.tag === 'string' ? body.tag : 'attendance',
      });
      return created;
    });

    this.app.post('/ags/lineitems/:lineItemId/scores', async (request, reply) => {
      if (!agsAuthOk(request)) return reply.code(401).send({ error: 'invalid_token' });
      // Score-only one-shot first, so failNextScorePost never eats a line-items request.
      if (this.agsScoreFailOnce) {
        const scoreKind = this.agsScoreFailOnce;
        this.agsScoreFailOnce = null;
        if (scoreKind === 'rate-limited') {
          reply.header('retry-after', '1');
          return reply.code(429).send({ error: 'rate_limited' });
        }
        if (scoreKind === 'server-error') return reply.code(500).send({ error: 'server_error' });
        return reply.code(422).send({ error: 'unprocessable' });
      }
      const failure = consumeAgsFailure(reply);
      if (failure) return failure;
      const { lineItemId } = request.params as { lineItemId: string };
      if (!this.lineItemScores.has(lineItemId)) return reply.code(404).send({ error: 'unknown_line_item' });
      this.lineItemScores.get(lineItemId)!.push((request.body ?? {}) as Record<string, unknown>);
      return reply.code(200).send({ resultUrl: `${this.baseUrl}/ags/lineitems/${lineItemId}/results/mock` });
    });

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

  lineItemsUrlFor(courseId: string): string {
    return `${this.baseUrl}/ags/${courseId}/lineitems`;
  }

  private createLineItem(
    courseId: string,
    fields: { scoreMaximum: number; label: string; resourceId: string; tag: string },
  ): { id: string; scoreMaximum: number; label: string; resourceId: string; tag: string } {
    const lineItemId = randomUUID();
    const id = `${this.baseUrl}/ags/lineitems/${lineItemId}`;
    const record = { id, ...fields };
    const list = this.lineItems.get(courseId) ?? [];
    list.push(record);
    this.lineItems.set(courseId, list);
    this.lineItemScores.set(lineItemId, []);
    return record;
  }

  /** Pre-create a line item (bypasses the create route) so a reuse path can be exercised. */
  seedExistingLineItem(
    courseId: string,
    overrides: Partial<{ scoreMaximum: number; label: string; resourceId: string; tag: string }> = {},
  ): string {
    return this.createLineItem(courseId, {
      scoreMaximum: overrides.scoreMaximum ?? 100,
      label: overrides.label ?? 'Attendance',
      resourceId: overrides.resourceId ?? 'attendance-cumulative-v1',
      tag: overrides.tag ?? 'attendance',
    }).id;
  }

  /**
   * Arm a one-shot failure for the NEXT AGS request of any kind. `'auth'` -> a 401 `invalid_token`
   * (a revoked/rotated token), which grade-worker.ts handles by clearing the token cache and
   * re-minting once.
   */
  failNextAgsRequest(kind: 'rate-limited' | 'server-error' | 'client-error' | 'auth'): void {
    this.agsFailOnce = kind;
  }

  /** Arm a one-shot failure for the NEXT score POST only, leaving line-item GET/POST untouched. */
  failNextScorePost(kind: 'rate-limited' | 'server-error' | 'client-error'): void {
    this.agsScoreFailOnce = kind;
  }

  getLineItems(courseId: string): ReadonlyArray<{ id: string; scoreMaximum: number; label: string; resourceId: string; tag: string }> {
    return this.lineItems.get(courseId) ?? [];
  }

  /** Every score posted to any line item of this course, oldest first. */
  getPostedScores(courseId: string): Array<Record<string, unknown>> {
    const ids = (this.lineItems.get(courseId) ?? []).map((li) => li.id.split('/').pop()!);
    return ids.flatMap((id) => this.lineItemScores.get(id) ?? []);
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
