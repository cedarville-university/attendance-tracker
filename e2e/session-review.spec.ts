import { test, expect } from '@playwright/test';
import { webhidShimScript } from './support/webhid-shim.js';
import { seedInstructorLaunch, teardownSeedResources } from './support/seed-launch.js';

// End-to-end for session review: launch -> start -> close -> reopen FROM the Past sessions panel
// -> close again -> delete FROM the panel -> Show deleted -> restore. Against the built server.

test.afterAll(async () => {
  await teardownSeedResources();
});

test('instructor: review, reopen-from-panel, delete and restore a past session', async ({ page, context }) => {
  page.on('dialog', (dialog) => dialog.accept('e2e'));
  await context.addInitScript(webhidShimScript);

  const seeded = await seedInstructorLaunch();
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
        input.value = value as string;
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
    },
    { url: seeded.launchUrl, fields: seeded.fields },
  );

  const startButton = page.getByRole('button', { name: 'Start Attendance' });
  await expect(startButton).toBeEnabled({ timeout: 20_000 });
  await startButton.click();
  await expect(page.locator('#session-status-text')).toHaveText(/Session open/i);

  await page.getByRole('button', { name: 'Submit attendance to Canvas' }).click();
  await expect(page.locator('#session-status-text')).toHaveText(/Attendance submitted/i);

  // Open the Past sessions panel — it refreshes on expand.
  const panel = page.locator('#session-history-panel');
  await panel.locator('summary').click();
  const row = page.locator('#session-history-table-body tr').first();
  await expect(row).toBeVisible();
  await expect(row.locator('.status-badge')).toHaveText('closed');

  // Reopen from the panel.
  await row.getByRole('button', { name: 'Reopen' }).click();
  await expect(page.locator('#session-status-text')).toHaveText(/Session reopened/i);

  // Close again, then delete from the panel (two-click inline confirm).
  await page.getByRole('button', { name: 'Submit attendance to Canvas' }).click();
  await expect(page.locator('#session-status-text')).toHaveText(/Attendance submitted/i);
  await panel.locator('summary').click(); // collapse
  await panel.locator('summary').click(); // expand -> refresh
  const delBtn = page.locator('#session-history-table-body tr').first().getByRole('button', { name: /Delete|Click again to delete/ });
  await delBtn.click();
  await delBtn.click();
  await expect(page.locator('#session-history-table-body tr')).toHaveCount(0);

  // That was the course's last closed session — the durable line-item removal warns the
  // instructor that the Canvas attendance column will be removed automatically (§10 reword).
  // Anchored on "column will be removed automatically" (not just "removed automatically"):
  // the retired interim copy ("...are not removed automatically") is also a substring match
  // for the looser pattern, so it would pass against either wording. This one only matches
  // the current copy and fails if the old wording comes back.
  await expect(page.getByText(/column will be removed automatically/i)).toBeVisible();

  // The deleted session was the one on screen -> the main view recovers to a
  // fresh no-session state instead of being stranded on "Attendance submitted".
  await expect(page.locator('#session-status-text')).toHaveText(/No session started/i);
  await expect(page.getByRole('button', { name: 'Start Attendance' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start Attendance' })).toBeEnabled();

  // Show deleted -> the row is back with a Restore action.
  await page.locator('#history-show-deleted').check();
  const deletedRow = page.locator('#session-history-table-body tr').first();
  await expect(deletedRow.locator('.status-badge')).toHaveText('deleted');
  await deletedRow.getByRole('button', { name: 'Restore' }).click();
  await expect(deletedRow.locator('.status-badge')).toHaveText('closed');
});
