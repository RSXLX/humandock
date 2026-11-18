import { expect, test, type Locator, type Page, type Response } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Task } from '../../packages/domain/src/model.js';

type DemoRole = 'buyer' | 'reviewer' | 'outsider';
const roleLabels: Record<DemoRole, string> = { buyer: 'Brand', reviewer: 'Reviewer', outsider: 'Other org' };

function responseAt(page: Page, path: string, method = 'POST') {
  return page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${path}` && response.request().method() === method);
}

async function clickMutation(page: Page, button: Locator, path: string): Promise<Response> {
  const [response] = await Promise.all([
    responseAt(page, path),
    button.click(),
  ]);
  // Protect the browser-to-API contract: UI writes must carry both tokens.
  const headers = response.request().headers();
  expect(headers['x-csrf-token'], `CSRF token for ${path}`).toBeTruthy();
  expect(headers['idempotency-key'], `Idempotency key for ${path}`).toMatch(/^[0-9a-f-]{36}$/i);
  return response;
}

async function successfulTaskMutation(page: Page, buttonName: string, taskId: string, action: string): Promise<Task> {
  const response = await clickMutation(page, page.getByRole('button', { name: buttonName, exact: true }), `/tasks/${taskId}/${action}`);
  expect(response.ok(), `${action}: ${await response.text()}`).toBeTruthy();
  return (await response.json() as { task: Task }).task;
}

async function switchRole(page: Page, role: DemoRole) {
  const button = page.getByRole('button', { name: roleLabels[role], exact: true });
  await expect(button).toBeEnabled();
  const [sessionResponse, tasksResponse] = await Promise.all([
    responseAt(page, '/demo/session'),
    responseAt(page, '/tasks', 'GET'),
    button.click(),
  ]);
  expect(sessionResponse.ok()).toBeTruthy();
  const session = await sessionResponse.json();
  expect(session.user.role).toBe(role);
  expect(session.user.identity.status).toBe('demo');
  expect(tasksResponse.ok()).toBeTruthy();
  await expect(page.getByRole('button', { name: roleLabels[role], exact: true })).toHaveAttribute('aria-pressed', 'true');
}

async function openTask(page: Page, title: string) {
  await page.getByRole('row', { name: `Open ${title}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
}

const criteria = [
  { title: 'Factual consistency', comment: 'The reviewed copy names only searchable notes, folders, and markdown export from the brief.' },
  { title: 'Natural US English', comment: 'The sentences are clear and natural for the specified US English audience.' },
  { title: 'Brand voice', comment: 'The revised tone is friendly, calm, and specific for independent designers.' },
  { title: 'Unsupported claims', comment: 'Removed unlimited notes, offline access, and the unsupported security superlative.' },
  { title: 'Channel fit', comment: 'The short Instagram text includes a clear call to action and matches the agreed brief.' },
];

test('human review, approval integrity, organization isolation, and service settlement remain independent', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const title = `Browser review ${randomUUID().slice(0, 8)}`;
  const sourceText = 'Meet Tide Notes, the world’s most secure workspace. Save unlimited notes and work offline anywhere. Try it free today.';
  const reviewedText = 'Give your ideas a home with Tide Notes. Organize searchable notes in folders and export them as markdown. Start with up to 100 notes on the free plan.';
  const summary = 'Removed unsupported security, unlimited-plan, and offline claims. The exact reviewed version now follows the supplied facts and calm brand voice.';
  let task!: Task;

  await test.step('start in an explicitly local demonstration and create a brand task', async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Good copy. A human second look.' })).toBeVisible();
    await expect(page.getByText('DEMO credits only. No real funds or ME identity certification.', { exact: false })).toBeVisible();
    await switchRole(page, 'buyer');
    await page.getByRole('button', { name: 'New review', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Review title', { exact: true }).fill(title);
    await dialog.getByLabel('Confirmed facts & brand voice', { exact: true }).fill([
      'Fictional product: Tide Notes, a note-taking web app.',
      'Features: searchable notes, folders, and markdown export.',
      'The free plan supports up to 100 notes. There is no offline mode.',
      'No security certifications or comparative security claims are provided.',
      'Audience: independent designers. Voice: friendly, calm, and specific.',
    ].join('\n'));
    await dialog.getByLabel('AI-assisted draft', { exact: true }).fill(sourceText);
    const response = await clickMutation(page, dialog.getByRole('button', { name: 'Create review', exact: true }), '/tasks');
    expect(response.ok(), await response.text()).toBeTruthy();
    task = (await response.json() as { task: Task }).task;
    expect(task.executionMode).toBe('demo');
    expect(task.status).toBe('DRAFT');
    await expect(dialog).toHaveCount(0);
    await openTask(page, title);
  });

  await test.step('freeze the quote and fund only local DEMO credits', async () => {
    task = await successfulTaskMutation(page, 'Get a fixed quote', task.id, 'quotes');
    expect(task.quote?.currency).toBe('DEMO');
    expect(task.quote?.reviewerAtoms).toBe('800000000000000000');
    expect(task.quote?.platformAtoms).toBe('200000000000000000');
    task = await successfulTaskMutation(page, 'Fund local demo', task.id, 'fund');
    expect(task.status).toBe('FUNDED');
    await expect(page.getByText('In demo escrow', { exact: true })).toBeVisible();
  });

  await test.step('switching organization clears the private task and report view', async () => {
    await switchRole(page, 'outsider');
    await expect(page.getByRole('row', { name: `Open ${title}`, exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
    await expect(page.getByText(sourceText, { exact: true })).toHaveCount(0);
    await expect(page.getByText('A different organization. A private queue.', { exact: true })).toBeVisible();
  });

  await test.step('the invited reviewer makes all five assessments and seals one PASS report', async () => {
    await switchRole(page, 'reviewer');
    await openTask(page, title);
    task = await successfulTaskMutation(page, 'Accept assignment', task.id, 'accept-assignment');
    expect(task.status).toBe('ASSIGNED');
    await page.getByLabel('Reviewed copy', { exact: true }).fill(reviewedText);
    await page.getByLabel('Human review summary', { exact: true }).fill(summary);
    await page.getByLabel('Verdict for the reviewed version', { exact: true }).selectOption('PASS');
    await expect(page.getByRole('button', { name: 'Submit human review', exact: true })).toBeDisabled();

    for (const criterion of criteria) {
      const card = page.locator('details.check-card').filter({ has: page.locator('summary').filter({ hasText: criterion.title }) });
      await expect(card, `Exactly one review criterion: ${criterion.title}`).toHaveCount(1);
      await card.locator('summary').click();
      await card.getByRole('combobox', { name: `${criterion.title} result`, exact: true }).selectOption('OK');
      await card.getByRole('textbox', { name: `${criterion.title} reasoning`, exact: true }).fill(criterion.comment);
      await card.getByRole('textbox', { name: `${criterion.title} evidence references`, exact: true }).fill('Confirmed product brief');
    }
    task = await successfulTaskMutation(page, 'Submit human review', task.id, 'reviews');
    expect(task.status).toBe('SUBMITTED');
    expect(task.report?.verdict).toBe('PASS');
    expect(task.report?.checks).toHaveLength(5);
    expect(task.report?.checks.every(check => check.result === 'OK')).toBe(true);
    await expect(page.getByText(summary, { exact: true })).toBeVisible();
    await expect(page.getByText('Immutable report', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('reviewed-task.png'), fullPage: true });
  });

  let approvedVersionId = '';
  await test.step('brand approval does not settle the service, and the exact approved copy exports', async () => {
    await switchRole(page, 'buyer');
    await openTask(page, title);
    await expect(page.getByRole('button', { name: 'Accept service & allocate', exact: true })).toBeEnabled();
    task = await successfulTaskMutation(page, 'Approve this version', task.id, 'approvals');
    expect(task.status).toBe('SUBMITTED');
    expect(task.closureReason).toBeNull();
    expect(task.approval?.versionId).toBe(task.report?.reviewedVersionId);
    approvedVersionId = task.approval!.versionId;
    await expect(page.getByRole('button', { name: 'Accept service & allocate', exact: true })).toBeEnabled();

    const response = await clickMutation(page, page.getByRole('button', { name: 'Check & export current', exact: true }), '/exports');
    expect(response.ok(), await response.text()).toBeTruthy();
    const result = await response.json();
    expect(result.export.executionMode).toBe('demo');
    await expect(page.getByText('Exact version checked', { exact: false })).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download exact copy', exact: true }).click();
    const download = await downloadPromise;
    const path = testInfo.outputPath('approved-copy.txt');
    await download.saveAs(path);
    expect(await readFile(path, 'utf8')).toBe(reviewedText);

    const receiptResponse = responseAt(page, `/exports/${result.export.id}/receipt`, 'GET');
    await page.getByRole('button', { name: 'Read private receipt', exact: true }).click();
    const receipt = await (await receiptResponse).json();
    expect(receipt.notice).toContain('NOT A ME ATTESTATION');
    expect(receipt.chain).toBeNull();
    expect(receipt.versionId).toBe(approvedVersionId);
  });

  await test.step('a changed copy cannot borrow the old approval: API and UI both reject it', async () => {
    await page.getByRole('button', { name: 'Review desk', exact: true }).click();
    await openTask(page, title);
    await page.getByRole('button', { name: 'Create changed version', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Changed copy', { exact: true }).fill(`${reviewedText}\nAn unreviewed addition.`);
    const changedResponse = await clickMutation(page, dialog.getByRole('button', { name: 'Save new version', exact: true }), `/tasks/${task.id}/versions`);
    expect(changedResponse.ok(), await changedResponse.text()).toBeTruthy();
    task = (await changedResponse.json() as { task: Task }).task;
    expect(task.currentVersionId).not.toBe(approvedVersionId);
    expect(task.approval?.versionId).toBe(approvedVersionId);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Version mismatch', { exact: true })).toBeVisible();

    const refused = await clickMutation(page, page.getByRole('button', { name: 'Check & export current', exact: true }), '/exports');
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error.code).toBe('APPROVAL_VERSION_MISMATCH');
    await expect(page.getByRole('alert').filter({ hasText: 'This version is not covered by that approval.' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Download exact copy', exact: true })).toHaveCount(0);
  });

  await test.step('the completed service can still be accepted independently of the changed content', async () => {
    task = await successfulTaskMutation(page, 'Accept service & allocate', task.id, 'accept-service');
    expect(task.status).toBe('CLOSED');
    expect(task.closureReason).toBe('NORMAL');
    expect(task.approval?.versionId).toBe(approvedVersionId);
    expect(task.currentVersionId).not.toBe(approvedVersionId);
    await expect(page.getByText('Allocation complete', { exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'allocated, not yet withdrawn' })).toBeVisible();

    await switchRole(page, 'reviewer');
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Allocated is not withdrawn.', exact: true })).toBeVisible();
    const response = await clickMutation(page, page.getByRole('button', { name: 'Withdraw DEMO credits', exact: true }), '/withdrawals');
    expect(response.ok(), await response.text()).toBeTruthy();
    const balance = await response.json();
    expect(balance.currency).toBe('DEMO');
    expect(balance.claimableAtoms).toBe('0');
    expect(BigInt(balance.withdrawnAtoms)).toBeGreaterThan(0n);
    await expect(page.getByRole('button', { name: 'Withdraw DEMO credits', exact: true })).toBeDisabled();
  });

  expect(pageErrors, 'No uncaught client-side errors during the lifecycle').toEqual([]);
});

test('mobile navigation exposes the explicit unavailable-wallet explanation', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  // An enabled role switch proves the client hydrated and the API readiness check
  // completed. The connection button itself is visible in the initial server HTML.
  await expect(page.getByRole('button', { name: 'Brand', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'ME connection', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'ME connection', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'ME connection is not ready.', exact: true })).toBeVisible();
  await expect(dialog.getByText('No wallet permission or signature has been requested.', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'The people behind the work.', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Integration, honestly reported.', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('mobile-workspace.png'), fullPage: true });
});
