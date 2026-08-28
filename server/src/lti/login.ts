export interface AllowedTargetLinkUris {
  isAllowed(uri: string): boolean;
}

export function createAllowlist(uris: string[]): AllowedTargetLinkUris {
  const set = new Set(uris);
  return { isAllowed: (uri: string) => set.has(uri) };
}

export interface LoginParams {
  iss: string;
  loginHint: string;
  targetLinkUri: string;
  clientId: string;
  deploymentId: string;
}

export interface LoginDeps {
  appBaseUrl: string;
  allowedTargetLinkUris: AllowedTargetLinkUris;
  findEnabledDeployment(
    iss: string,
    clientId: string,
    deploymentId: string,
  ): Promise<{
    registration: { id: string; oidcAuthEndpoint: string };
    deployment: { id: string; deploymentId: string };
  } | null>;
  createTransaction(params: {
    registrationId: string;
    deploymentId: string;
    targetLinkUri: string;
  }): Promise<{ state: string; nonce: string }>;
}

export type LoginResult =
  | { ok: true; redirectUrl: string; state: string }
  | { ok: false; reason: 'unknown_deployment' | 'disallowed_target_link_uri' };

export async function buildLoginRedirect(params: LoginParams, deps: LoginDeps): Promise<LoginResult> {
  if (!deps.allowedTargetLinkUris.isAllowed(params.targetLinkUri)) {
    return { ok: false, reason: 'disallowed_target_link_uri' };
  }

  const enabled = await deps.findEnabledDeployment(params.iss, params.clientId, params.deploymentId);
  if (!enabled) {
    return { ok: false, reason: 'unknown_deployment' };
  }

  const { state, nonce } = await deps.createTransaction({
    registrationId: enabled.registration.id,
    deploymentId: enabled.deployment.deploymentId,
    targetLinkUri: params.targetLinkUri,
  });

  const redirectUrl = new URL(enabled.registration.oidcAuthEndpoint);
  redirectUrl.searchParams.set('client_id', params.clientId);
  redirectUrl.searchParams.set('login_hint', params.loginHint);
  // new URL(path, base) tolerates a trailing slash on appBaseUrl (env.ts already
  // normalizes it to an origin, but this keeps the join correct regardless).
  redirectUrl.searchParams.set('redirect_uri', new URL('/lti/launch', deps.appBaseUrl).toString());
  redirectUrl.searchParams.set('state', state);
  redirectUrl.searchParams.set('nonce', nonce);
  redirectUrl.searchParams.set('response_type', 'id_token');
  redirectUrl.searchParams.set('response_mode', 'form_post');
  redirectUrl.searchParams.set('scope', 'openid');

  return { ok: true, redirectUrl: redirectUrl.toString(), state };
}
