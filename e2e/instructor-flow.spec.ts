import { test, expect } from '@playwright/test';
import { webhidShimScript } from './support/webhid-shim.js';
import {
  seedInstructorLaunch,
  runWorkerOnce,
  readGradeSyncSummary,
  teardownSeedResources,
} from './support/seed-launch.js';

// One end-to-end pass against the BUILT server (node server/dist/index.js) and real Postgres:
// Canvas OIDC login -> LTI launch (POSTed form, session cookie) -> the real scanner SPA ->
// Start Attendance -> a synthetic WebHID scan that resolves to a roster learner (Present) ->
// Close -> Reopen -> `node server/dist/worker.js` -> the grade-sync summary reflects the close.
// No UI is mocked; only navigator.hid is shimmed (there is no card reader in CI).

test.afterAll(async () => {
  await teardownSeedResources();
});

test('instructor: login -> launch -> start -> scan -> close -> reopen -> grade sync', async ({ page, context }) => {
  // window.prompt() in web/app.js reopenSession() — auto-accept so the flow proceeds.
  page.on('dialog', (dialog) => dialog.accept('e2e reopen'));
  await context.addInitScript(webhidShimScript);

  const seeded = await seedInstructorLaunch();

  // Load the SPA once (no session yet), then POST the launch form from this same-origin document so
  // the 303 response's Set-Cookie lands and the redirect reloads the app authenticated.
  await page.goto('/index.html');
  await page.evaluate(
    ({ url, fields }) => {
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = url;
      for (const [name, value] of Object.entries(fields)) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
    },
    { url: seeded.launchUrl, fields: seeded.fields },
  );

  // Authenticated: GET /api/me succeeded, so the Start button is enabled (web/app.js init()).
  const startButton = page.getByRole('button', { name: 'Start Attendance' });
  await expect(startButton).toBeEnabled({ timeout: 20_000 });

  // Task 22B: the Canvas course context + roster render from /api/me and
  // /api/course/roster without any CSV upload.
  await expect(page.locator('#course-context')).toBeVisible();
  await expect(page.locator('#course-context-name')).toHaveText('E2E Course'); // context.title from seed-launch.ts
  await expect(page.locator('#course-context-roster-count')).toHaveText('2 students');
  await expect(page.locator('#canvas-roster-table-body tr')).toHaveCount(2);
  await expect(page.locator('#canvas-roster-table-body tr').first()).toContainText('E2E Test Learner');

  // The shimmed reader auto-reconnects on load (web/hid-reader.js reconnectKnownDevices()).
  await expect(page.locator('#reader-status-text')).toHaveText('Connected');

  // Start Attendance — capture the created session id from the POST response.
  const createResponse = page.waitForResponse(
    (res) =>
      res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/attendance-sessions',
  );
  await startButton.click();
  const sessionId = (await (await createResponse).json()).id as string;
  expect(sessionId).toBeTruthy();
  await expect(page.locator('#session-status-text')).toHaveText(/Session open/i);

  // Synthetic scan: one inputreport whose payload is E2E_CARD_CODE. The mock identity resolver maps
  // it to the seeded roster learner, so the server returns status "present".
  const scanResponse = page.waitForResponse((res) => res.url().includes(`/scans`) && res.request().method() === 'POST');
  await page.evaluate((bytes) => {
    const emit = (window as unknown as { __emitCard: (b: number[]) => boolean }).__emitCard;
    if (!emit(bytes)) throw new Error('__emitCard: reader not open (oninputreport unset)');
  }, seeded.cardReportBytes);
  expect((await scanResponse).ok()).toBe(true);

  await expect(page.locator('#latest-scan-status-text')).toHaveText(/Present/i);
  await expect(page.locator('#attendance-table-body .status-badge').first()).toHaveText('Present');
  await expect(page.locator('#attendance-table-body .col-university-id').first()).toHaveText(
    seeded.learner.universityId,
  );

  // Manual "mark present": the second rostered learner never scanned a card. Pick them from the
  // dropdown and confirm a new Present row appears and they drop out of the picker.
  const manualGroup = page.locator('#manual-present-group');
  await expect(manualGroup).toBeVisible();
  await page.locator('#manual-present-select').selectOption(seeded.cardlessLearner.ltiUserId);
  await page.getByRole('button', { name: 'Mark present' }).click();
  await expect(
    page.locator(`#attendance-table-body tr:has(.col-university-id:text-is("${seeded.cardlessLearner.universityId}")) .status-badge`),
  ).toHaveText('Present');
  await expect(page.locator('#btn-manual-present')).toBeDisabled(); // nobody left to mark
  await expect(page.locator('#manual-present-select')).not.toContainText(seeded.cardlessLearner.name);

  // Close — unscanned eligible members become absent; grade-sync jobs are enqueued (pending).
  await page.getByRole('button', { name: 'Close Attendance' }).click();
  await expect(page.locator('#session-status-text')).toHaveText(/Session closed/i);
  await expect(page.locator('#grade-sync-panel')).toBeVisible();
  await expect(page.locator('#manual-present-group')).toBeHidden();
  // Richer summary line: a "N of M students" count plus a scheduling phrase.
  await expect(page.locator('#grade-sync-status-text')).toHaveText(/of \d+ students/i);
  await expect(page.locator('#grade-sync-status-text')).toHaveText(/next sync attempt|last synced/i);

  // Reopen — scans accepted again; grade-sync jobs are deliberately left untouched.
  await page.getByRole('button', { name: 'Reopen Attendance' }).click();
  await expect(page.locator('#session-status-text')).toHaveText(/Session reopened/i);

  // Run the grade worker once; it drives the enqueued job against the mock Canvas AGS endpoints.
  const worker = await runWorkerOnce();
  expect(worker.code, `worker stderr: ${worker.stderr}`).toBe(0);

  const summary = await readGradeSyncSummary(page.request, sessionId);
  // The mock Canvas AGS endpoints are reachable from the worker process, so the enqueued job
  // should post and settle to "synced"; tolerate "pending" only as a non-flaky fallback.
  expect(summary.state, JSON.stringify(summary)).toMatch(/^(synced|pending)$/);
  expect(summary.counts.failed).toBe(0);
  expect(summary.counts.synced).toBeGreaterThan(0);
});
