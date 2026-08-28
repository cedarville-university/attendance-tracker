import { describe, it, expect, vi } from 'vitest';
import { createAllowlist, buildLoginRedirect, type LoginDeps } from '../../src/lti/login.js';

function makeDeps(overrides: Partial<LoginDeps> = {}): LoginDeps {
  return {
    appBaseUrl: 'https://app.test',
    allowedTargetLinkUris: createAllowlist(['https://app.test/index.html']),
    findEnabledDeployment: vi.fn().mockResolvedValue({
      registration: { id: 'reg-1', oidcAuthEndpoint: 'https://canvas.test/authorize' },
      deployment: { id: 'dep-row-1', deploymentId: 'deploy-1' },
    }),
    createTransaction: vi.fn().mockResolvedValue({ state: 'state-value', nonce: 'nonce-value' }),
    ...overrides,
  };
}

const BASE_PARAMS = {
  iss: 'https://canvas.test',
  loginHint: 'hint-123',
  targetLinkUri: 'https://app.test/index.html',
  clientId: 'client-1',
  deploymentId: 'deploy-1',
};

describe('buildLoginRedirect', () => {
  it('builds a redirect URL with all required OIDC parameters on success', async () => {
    const deps = makeDeps();
    const result = await buildLoginRedirect(BASE_PARAMS, deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const url = new URL(result.redirectUrl);
      expect(url.origin + url.pathname).toBe('https://canvas.test/authorize');
      expect(url.searchParams.get('client_id')).toBe('client-1');
      expect(url.searchParams.get('login_hint')).toBe('hint-123');
      expect(url.searchParams.get('redirect_uri')).toBe('https://app.test/lti/launch');
      expect(url.searchParams.get('state')).toBe('state-value');
      expect(url.searchParams.get('nonce')).toBe('nonce-value');
      expect(url.searchParams.get('response_type')).toBe('id_token');
      expect(url.searchParams.get('response_mode')).toBe('form_post');
      expect(url.searchParams.get('scope')).toBe('openid');
    }
  });

  it('builds a redirect_uri with no double slash even when appBaseUrl carries a trailing slash', async () => {
    const deps = makeDeps({ appBaseUrl: 'https://app.test/' });
    const result = await buildLoginRedirect(BASE_PARAMS, deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const redirectUri = new URL(result.redirectUrl).searchParams.get('redirect_uri');
      expect(redirectUri).toBe('https://app.test/lti/launch');
      expect(redirectUri?.replace('https://', '')).not.toContain('//');
    }
  });

  it('§45 case 24: rejects a target_link_uri not on the exact-match allowlist (open-redirect attempt)', async () => {
    const deps = makeDeps();
    const result = await buildLoginRedirect(
      { ...BASE_PARAMS, targetLinkUri: 'https://evil.test/steal-tokens' },
      deps,
    );

    expect(result).toEqual({ ok: false, reason: 'disallowed_target_link_uri' });
    expect(deps.findEnabledDeployment).not.toHaveBeenCalled();
    expect(deps.createTransaction).not.toHaveBeenCalled();
  });

  it('rejects a target_link_uri that is merely a prefix/substring match, not exact', async () => {
    const deps = makeDeps({ allowedTargetLinkUris: createAllowlist(['https://app.test/index.html']) });
    const result = await buildLoginRedirect(
      { ...BASE_PARAMS, targetLinkUri: 'https://app.test/index.html?malicious=1' },
      deps,
    );

    expect(result).toEqual({ ok: false, reason: 'disallowed_target_link_uri' });
  });

  it('rejects an unknown/disabled deployment', async () => {
    const deps = makeDeps({ findEnabledDeployment: vi.fn().mockResolvedValue(null) });
    const result = await buildLoginRedirect(BASE_PARAMS, deps);

    expect(result).toEqual({ ok: false, reason: 'unknown_deployment' });
    expect(deps.createTransaction).not.toHaveBeenCalled();
  });
});
