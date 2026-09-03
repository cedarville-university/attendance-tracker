import { test, expect } from '@playwright/test';
import { BASE_URL } from './support/seed-launch.js';

// Keep in sync with playwright.config.ts (webServer.env.SETUP_TOKEN).
const E2E_SETUP_TOKEN = process.env.E2E_SETUP_TOKEN ?? 'e2e-setup-token-0123456789';

// The admin/setup page (Feature 3) against the BUILT server, using the SETUP_TOKEN bootstrap path
// (playwright.config.ts sets SETUP_TOKEN in the webServer env). No Canvas launch involved: the
// token stands in for an Administrator-role session.

test('admin: token bootstrap -> add a Canvas connection -> rotate the signing key', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept()); // window.confirm() in the rotate handler

  await page.goto('/admin.html');

  // No session -> the setup-token form is shown.
  const tokenForm = page.locator('#setup-token-form');
  await expect(tokenForm).toBeVisible();
  await page.locator('#setup-token-input').fill(E2E_SETUP_TOKEN);
  await page.getByRole('button', { name: 'Continue' }).click();

  // Authorized: the connections + signing-key panels appear.
  await expect(page.locator('#connections-panel')).toBeVisible();
  await expect(page.locator('#signing-key-panel')).toBeVisible();

  // Add a Canvas connection via the form.
  const uniqueIssuer = `https://canvas.e2e-${Date.now()}.instructure.com`;
  await page.fill('input[name="institutionSlug"]', 'e2e-admin');
  await page.fill('input[name="institutionName"]', 'E2E Admin University');
  await page.fill('input[name="issuer"]', uniqueIssuer);
  await page.fill('input[name="clientId"]', 'e2e-client-1');
  await page.fill('input[name="oidcAuthEndpoint"]', 'https://sso.e2e.canvaslms.com/api/lti/authorize_redirect');
  await page.fill('input[name="tokenEndpoint"]', 'https://sso.e2e.canvaslms.com/login/oauth2/token');
  await page.fill('input[name="platformJwksUri"]', 'https://sso.e2e.canvaslms.com/api/lti/security/jwks');
  await page.fill('input[name="deploymentId"]', 'e2e-deploy-1');
  await page.getByRole('button', { name: 'Save connection' }).click();

  const row = page.locator('#registrations-table-body tr', { hasText: uniqueIssuer });
  await expect(row).toBeVisible();
  await expect(row).toContainText('e2e-deploy-1');

  // Rotate the signing key; the displayed kid changes and /lti/jwks then serves it.
  // Rotate is a two-click inline confirm (bindInlineConfirm), not a window.confirm dialog:
  // the first click arms the button (label swaps to "Click again to rotate") and the
  // second, on the same element, actually confirms. Asserting the armed label is visible
  // in between (rather than one locator matching either label) means this test would fail
  // if the confirm step were ever removed and the click rotated immediately.
  const kidBefore = await page.locator('#signing-key-kid').textContent();
  const rotateBtn = page.getByRole('button', { name: 'Rotate key' });
  await rotateBtn.click();
  const armedRotateBtn = page.getByRole('button', { name: 'Click again to rotate' });
  await expect(armedRotateBtn).toBeVisible();
  await armedRotateBtn.click();
  await expect(page.locator('#signing-key-kid')).not.toHaveText(kidBefore ?? '');
  const kidAfter = (await page.locator('#signing-key-kid').textContent())!.trim();

  const jwks = await page.request.get(`${BASE_URL}/lti/jwks`);
  expect(jwks.ok()).toBe(true);
  const body = (await jwks.json()) as { keys: { kid: string }[] };
  expect(body.keys.map((k) => k.kid)).toContain(kidAfter);
});
