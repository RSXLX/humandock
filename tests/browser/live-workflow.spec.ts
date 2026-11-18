import { expect, test, type Locator, type Page, type Response } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createWalletClient, defineChain, http, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import type { Task } from '../../packages/domain/src/model.js';

// Public, disposable development accounts only. The keys never enter the browser
// or product bundle, and the bridge refuses every network except this local chain.
const mnemonic = 'test test test test test test test test test test test junk';
const buyer = mnemonicToAccount(mnemonic, { addressIndex: 6 });
const reviewer = mnemonicToAccount(mnemonic, { addressIndex: 7 });
const localChain = defineChain({ id: 31337, name: 'HumanDock local chain test', nativeCurrency: { name: 'Local test currency', symbol: 'LOCAL', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1:18545'] } } });
type Intent = { id: string; action: string; account: string; status: string; txHash?: string; applied: boolean; confirmations: number; requiredConfirmations: number; summary: { title: string; amountWei: string; deliveryCommitment?: string; receiver?: string; withdrawalAmountWei?: string }; typedData?: unknown; transaction?: { value: string }; block?: { number: string; hash: string }; error?: { message: string } };
type RpcCall = { method: string; params: unknown[] };
type WalletTestWindow = Window & { __humanDockWallet: { emit: (event: string, payload: unknown) => void } };

function responseAt(page: Page, path: string, method = 'POST') {
  return page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${path}` && response.request().method() === method);
}
async function mutate(page: Page, button: Locator, path: string): Promise<Response> {
  const [response] = await Promise.all([responseAt(page, path), button.click()]);
  expect(response.request().headers()['x-csrf-token'], `CSRF for ${path}`).toBeTruthy();
  expect(response.request().headers()['idempotency-key'], `Idempotency for ${path}`).toMatch(/^[0-9a-f-]{36}$/i);
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return response;
}

async function installLocalWallet(page: Page) {
  let account = buyer;
  let selectedChain = '0x1'; // Exercise an explicit switch; do not silently select the app network.
  let declineNextSignature = false;
  const calls: RpcCall[] = [];
  const broadcasts: string[] = [];
  await page.exposeFunction('__humanDockLocalWalletRpc', async ({ method, params = [] }: RpcCall) => {
    calls.push({ method, params });
    try {
      const client = createWalletClient({ account, chain: localChain, transport: http('http://127.0.0.1:18545') });
      let result: unknown;
      switch (method) {
        case 'eth_requestAccounts': case 'eth_accounts': result = [account.address]; break;
        case 'eth_chainId': result = selectedChain; break;
        case 'wallet_switchEthereumChain': {
          const requested = (params[0] as { chainId: string }).chainId;
          if (requested !== '0x7a69') throw Object.assign(new Error('Only the disposable local test chain is permitted.'), { code: 4902 });
          selectedChain = requested; result = null; break;
        }
        case 'personal_sign': {
          if (selectedChain !== '0x7a69') throw Object.assign(new Error('Wrong test wallet network.'), { code: 4901 });
          expect(String(params[1]).toLowerCase()).toBe(account.address.toLowerCase());
          result = await client.signMessage({ message: { raw: params[0] as Hex } }); break;
        }
        case 'eth_signTypedData_v4': {
          if (declineNextSignature) { declineNextSignature = false; throw Object.assign(new Error('Fixture user declined this signature.'), { code: 4001 }); }
          if (selectedChain !== '0x7a69') throw Object.assign(new Error('Wrong test wallet network.'), { code: 4901 });
          expect(String(params[0]).toLowerCase()).toBe(account.address.toLowerCase());
          const data = JSON.parse(String(params[1]));
          expect(Number(data.domain.chainId)).toBe(31337);
          result = await client.signTypedData(data as Parameters<typeof client.signTypedData>[0]); break;
        }
        case 'eth_sendTransaction': {
          if (selectedChain !== '0x7a69') throw Object.assign(new Error('Wrong test wallet network.'), { code: 4901 });
          const tx = params[0] as { from: string; to: Hex; data: Hex; value: Hex; chainId: string };
          expect(tx.from.toLowerCase()).toBe(account.address.toLowerCase());
          expect(Number(BigInt(tx.chainId))).toBe(31337);
          result = await client.sendTransaction({ account, chain: localChain, to: tx.to, data: tx.data, value: BigInt(tx.value) });
          broadcasts.push(String(result)); break;
        }
        default: throw Object.assign(new Error(`Unsupported fixture wallet method: ${method}`), { code: 4200 });
      }
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: { code: (error as { code?: number }).code || -32603, message: error instanceof Error ? error.message : String(error) } };
    }
  });
  await page.addInitScript(() => {
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    const emit = (event: string, value: unknown) => listeners.get(event)?.forEach(listener => listener(value));
    const provider = {
      async request(request: { method: string; params?: unknown[] }) {
        const bridge = (window as unknown as { __humanDockLocalWalletRpc: (request: { method: string; params?: unknown[] }) => Promise<{ ok: boolean; result?: unknown; error?: { code: number; message: string } }> }).__humanDockLocalWalletRpc;
        const response = await bridge(request);
        if (!response.ok) throw Object.assign(new Error(response.error?.message), { code: response.error?.code });
        if (request.method === 'wallet_switchEthereumChain') emit('chainChanged', (request.params?.[0] as { chainId: string }).chainId);
        return response.result;
      },
      on(event: string, listener: (value: unknown) => void) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(listener); },
      removeListener(event: string, listener: (value: unknown) => void) { listeners.get(event)?.delete(listener); },
    };
    Object.defineProperty(window, 'ethereum', { value: provider, configurable: false });
    Object.defineProperty(window, '__humanDockWallet', { value: { emit }, configurable: false });
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: '30aef0b5-bf6d-4266-a416-3820e8306569', name: 'HumanDock local test wallet', icon: '', rdns: 'test.humandock.local' }, provider } }));
    window.addEventListener('eip6963:requestProvider', announce);
  });
  return {
    calls, broadcasts,
    declineSignature: () => { declineNextSignature = true; },
    async select(next: 'buyer' | 'reviewer') {
      account = next === 'buyer' ? buyer : reviewer;
      await page.evaluate(address => (window as unknown as WalletTestWindow).__humanDockWallet.emit('accountsChanged', [address]), account.address);
      // The provider event returns before React commits its session invalidation
      // and automatic wallet panel. Wait for that actual UI before signIn decides
      // whether it needs to click the background connection button.
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: 'Connect your workspace wallet.', exact: true })).toBeVisible();
      await expect(dialog.locator('.wallet-account code')).toHaveText(account.address);
    },
  };
}

async function signIn(page: Page, role: 'buyer' | 'reviewer', refreshIdentity = true) {
  let dialog = page.getByRole('dialog');
  if (!await dialog.count()) await page.getByRole('button', { name: 'ME connection', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Connect your workspace wallet.', exact: true })).toBeVisible();
  const connect = dialog.getByRole('button', { name: /HumanDock local test wallet/ });
  await expect(connect).toBeEnabled(); await connect.click();
  await expect(dialog.locator(".wallet-account code")).toHaveText(role === "buyer" ? buyer.address : reviewer.address);
  const switchButton = dialog.getByRole('button', { name: /^Switch to / });
  if (await switchButton.count()) await switchButton.click();
  const challengeButton = dialog.getByRole('button', { name: 'Review sign-in message', exact: true });
  await expect(challengeButton).toBeEnabled();
  const [challenge] = await Promise.all([responseAt(page, '/auth/challenge'), challengeButton.click()]);
  expect(challenge.ok(), await challenge.text()).toBeTruthy();
  await expect(dialog.locator('.signin-message')).toContainText('wants you to sign in with your Ethereum account:');
  const [verified] = await Promise.all([responseAt(page, '/auth/verify'), dialog.getByRole('button', { name: 'Sign in with wallet', exact: true }).click()]);
  expect(verified.ok(), await verified.text()).toBeTruthy();
  const session = await verified.json();
  expect(session.user.role).toBe(role);
  expect(session.user.identity.status).toBe('pending');
  if (refreshIdentity) {
    const refreshed = await mutate(page, dialog.getByRole('button', { name: 'Refresh identity status', exact: true }), '/me/identity/refresh');
    expect((await refreshed.json()).user.identity.status).toBe('local_test');
  }
  await expect(dialog.getByRole('button', { name: 'Close dialog', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

async function prepare(page: Page, buttonName: string): Promise<Intent> {
  const response = await mutate(page, page.getByRole('button', { name: buttonName, exact: true }), '/me/intents');
  const intent = (await response.json() as { intent: Intent }).intent;
  await expect(page.getByRole('dialog').getByRole('heading', { name: intent.summary.title, exact: true })).toBeVisible();
  expect(intent.applied).toBe(false);
  return intent;
}
async function finishTransaction(page: Page, prepared: Intent, wallet: Awaited<ReturnType<typeof installLocalWallet>>) {
  const dialog = page.getByRole('dialog');
  let intent = prepared;
  if (intent.status === 'awaiting_signature') {
    const beforeBroadcasts = wallet.broadcasts.length;
    const signed = await mutate(page, dialog.getByRole('button', { name: 'Sign commitment in wallet', exact: true }), `/me/intents/${intent.id}/signature`);
    intent = (await signed.json()).intent;
    expect(intent.status).toBe('ready');
    expect(wallet.broadcasts.length, 'Typed signature does not send a transaction').toBe(beforeBroadcasts);
  }
  expect(intent.status).toBe('ready');
  const beforeBroadcasts = wallet.broadcasts.length;
  const broadcast = await mutate(page, dialog.getByRole('button', { name: 'Send transaction in wallet', exact: true }), `/me/intents/${intent.id}/broadcast`);
  const registered = (await broadcast.json()).intent as Intent;
  expect(wallet.broadcasts).toHaveLength(beforeBroadcasts + 1);
  expect(registered.txHash).toBe(wallet.broadcasts.at(-1));
  expect(registered.applied, 'Registering a hash alone never applies a product result').toBe(false);
  const reconciledResponse = page.waitForResponse(async response => {
    if (new URL(response.url()).pathname !== `/api/v1/me/intents/${intent.id}/reconcile` || !response.ok()) return false;
    const result = await response.json();
    return result.intent.status === 'confirmed' && result.intent.applied;
  }, { timeout: 90_000 });
  await expect(dialog.getByRole('button', { name: 'Reconcile transaction', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Reconcile transaction', exact: true }).click();
  const result = await (await reconciledResponse).json() as { intent: Intent; task?: Task };
  expect(result.intent.txHash).toBe(registered.txHash);
  expect(result.intent.confirmations).toBeGreaterThanOrEqual(result.intent.requiredConfirmations);
  expect(result.intent.block?.hash).toMatch(/^0x[0-9a-f]{64}$/i);
  expect(BigInt(result.intent.block!.number)).toBeGreaterThan(0n);
  await expect(dialog.getByText('Chain result reconciled.', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  return result;
}
async function openTask(page: Page, title: string) {
  await page.getByRole('button', { name: 'Review desk', exact: true }).click();
  await page.getByRole('row', { name: `Open ${title}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
}

const criteria = ['Factual consistency', 'Natural US English', 'Brand voice', 'Unsupported claims', 'Channel fit'];
test('local-chain wallet login, independent approval, settlement and withdrawal reconcile real receipts', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const wallet = await installLocalWallet(page);
  const title = `Wallet review ${randomUUID().slice(0, 8)}`;
  const sourceText = 'Meet Tide Notes. Save unlimited notes securely and work offline anywhere.';
  const reviewedText = 'Give your ideas a home with Tide Notes. Organize searchable notes in folders and export them as markdown. Start with up to 100 notes on the free plan.';
  let task!: Task;
  let reviewedVersionId = '';

  await test.step('explicit wallet connection, network switch, real SIWE and labelled local identity', async () => {
    await page.goto('/');
    await expect(page.getByRole('region', { name: 'Wallet mode and identity' })).toContainText('Local chain test');
    expect(wallet.calls, 'Provider discovery never requests wallet permission').toEqual([]);
    await signIn(page, 'buyer');
    expect(wallet.calls.some(call => call.method === 'wallet_switchEthereumChain')).toBe(true);
    expect(wallet.calls.filter(call => call.method === 'personal_sign')).toHaveLength(1);
    await expect(page.getByRole('button', { name: 'Brand', exact: true })).toHaveCount(0);
  });

  await test.step('invite a real fixture reviewer and fund the exact quoted contract amount', async () => {
    await page.getByRole('button', { name: 'New review', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Review title', { exact: true }).fill(title);
    await dialog.getByLabel('Confirmed facts & brand voice', { exact: true }).fill('Fictional Tide Notes app. Searchable notes, folders, markdown export. Free plan: up to 100 notes. No offline mode and no security certification. Friendly, calm voice for independent designers.');
    await dialog.getByLabel('AI-assisted draft', { exact: true }).fill(sourceText);
    await expect(dialog.getByLabel('Invited reviewer', { exact: true })).toBeEnabled();
    await dialog.getByLabel('Invited reviewer', { exact: true }).selectOption(reviewer.address);
    task = (await (await mutate(page, dialog.getByRole('button', { name: 'Create review', exact: true }), '/tasks')).json()).task;
    expect(task.executionMode).toBe('me');
    await openTask(page, title);
    task = (await (await mutate(page, page.getByRole('button', { name: 'Get a fixed quote', exact: true }), `/tasks/${task.id}/quotes`)).json()).task;
    const before = wallet.broadcasts.length;
    const intent = await prepare(page, 'Review escrow funding');
    expect(intent.summary.amountWei).toBe(task.quote!.totalAtoms);
    expect(BigInt(intent.transaction!.value)).toBe(BigInt(task.quote!.totalAtoms));
    expect(wallet.broadcasts).toHaveLength(before);
    const result = await finishTransaction(page, intent, wallet);
    task = result.task!; expect(task.status).toBe('FUNDED');
    expect(task.chain?.lastTxHash).toBe(result.intent.txHash);
  });

  await test.step('account changes clear private data before the reviewer signs in', async () => {
    await wallet.select('reviewer');
    await expect(page.getByRole('row', { name: `Open ${title}`, exact: true })).toHaveCount(0);
    await expect(page.getByText(sourceText, { exact: true })).toHaveCount(0);
    await signIn(page, 'reviewer');
    await openTask(page, title);
    task = (await finishTransaction(page, await prepare(page, 'Accept assignment'), wallet)).task!;
    expect(task.status).toBe('ASSIGNED');
  });

  await test.step('a declined signature is retried explicitly, then the report is sent separately', async () => {
    await page.getByLabel('Reviewed copy', { exact: true }).fill(reviewedText);
    await page.getByLabel('Human review summary', { exact: true }).fill('Removed unlimited notes, security, and offline claims. The reviewed version now follows the supplied facts and calm brand voice.');
    await page.getByLabel('Verdict for the reviewed version', { exact: true }).selectOption('PASS');
    for (const criterion of criteria) {
      const card = page.locator('details.check-card').filter({ has: page.locator('summary').filter({ hasText: criterion }) });
      await card.locator('summary').click();
      await card.getByRole('combobox', { name: `${criterion} result`, exact: true }).selectOption('OK');
      await card.getByRole('textbox', { name: `${criterion} reasoning`, exact: true }).fill(`Checked ${criterion.toLowerCase()} against the supplied product facts and agreed review rubric.`);
      await card.getByRole('textbox', { name: `${criterion} evidence references`, exact: true }).fill('Confirmed product brief');
    }
    const intent = await prepare(page, 'Submit human review');
    expect(intent.status).toBe('awaiting_signature');
    expect(JSON.stringify(intent.typedData)).not.toContain(reviewedText);
    const before = wallet.broadcasts.length;
    wallet.declineSignature();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Sign commitment in wallet', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Wallet request declined.');
    expect(wallet.broadcasts).toHaveLength(before);
    task = (await finishTransaction(page, intent, wallet)).task!;
    expect(task.status).toBe('SUBMITTED');
    expect(task.report?.verdict).toBe('PASS');
    reviewedVersionId = task.report!.reviewedVersionId;
    await expect(page.getByText('Immutable report', { exact: true })).toBeVisible();
  });

  await test.step('brand authorization is independent of payment and exact copy exports against chain approval', async () => {
    await wallet.select('buyer');
    // Existing authorization/settlement actions are not gated on a fresh KYC refresh.
    await signIn(page, 'buyer', false);
    await openTask(page, title);
    task = (await finishTransaction(page, await prepare(page, 'Approve this version'), wallet)).task!;
    expect(task.status).toBe('SUBMITTED');
    expect(task.approval?.versionId).toBe(reviewedVersionId);
    await expect(page.getByRole('button', { name: 'Accept service & allocate', exact: true })).toBeEnabled();
    const exportResponse = await mutate(page, page.getByRole('button', { name: 'Check & export current', exact: true }), '/exports');
    const record = (await exportResponse.json()).export;
    expect(record.executionMode).toBe('me');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download exact copy', exact: true }).click();
    const download = await downloadPromise;
    const path = testInfo.outputPath('chain-approved-copy.txt'); await download.saveAs(path);
    expect(await readFile(path, 'utf8')).toBe(reviewedText);
    const receiptResponse = responseAt(page, `/exports/${record.id}/receipt`, 'GET');
    await page.getByRole('button', { name: 'Read private receipt', exact: true }).click();
    const receipt = await (await receiptResponse).json();
    expect(receipt.chain).toBeTruthy();
    expect(receipt.versionId).toBe(reviewedVersionId);
    await testInfo.attach('chain-export-receipt.json', { body: JSON.stringify(receipt, null, 2), contentType: 'application/json' });
    await openTask(page, title);
  });

  await test.step('a changed version fails the API authorization boundary before service settlement', async () => {
    await page.getByRole('button', { name: 'Create changed version', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Changed copy', { exact: true }).fill(`${reviewedText}\nThis sentence was never reviewed.`);
    task = (await (await mutate(page, dialog.getByRole('button', { name: 'Save new version', exact: true }), `/tasks/${task.id}/versions`)).json()).task;
    expect(task.currentVersionId).not.toBe(reviewedVersionId);
    const [refused] = await Promise.all([responseAt(page, '/exports'), page.getByRole('button', { name: 'Check & export current', exact: true }).click()]);
    expect(refused.status()).toBe(409);
    await expect(page.getByRole('alert').filter({ hasText: 'This version is not covered by that approval.' })).toBeVisible();
    task = (await finishTransaction(page, await prepare(page, 'Accept service & allocate'), wallet)).task!;
    expect(task.status).toBe('CLOSED');
    expect(task.approval?.versionId).toBe(reviewedVersionId);
    await expect(page.getByText('Allocation complete', { exact: true })).toBeVisible();
  });

  await test.step('allocated reviewer funds require a separate wallet withdrawal and reconciled receipt', async () => {
    await wallet.select('reviewer'); await signIn(page, 'reviewer', false);
    const balanceResponse = responseAt(page, '/balances', 'GET');
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    // A session reload may have already fetched balances. The explicit button is deterministic.
    await expect(page.getByRole('button', { name: 'Refresh balances', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Refresh balances', exact: true }).click();
    const before = await (await balanceResponse).json();
    expect(BigInt(before.claimableAtoms)).toBeGreaterThan(0n);
    const intent = await prepare(page, 'Review withdrawal');
    expect(intent.summary.amountWei).toBe('0');
    expect(intent.summary.receiver?.toLowerCase()).toBe(reviewer.address.toLowerCase());
    expect(BigInt(intent.summary.withdrawalAmountWei!)).toBeGreaterThan(0n);
    await finishTransaction(page, intent, wallet);
    await expect(page.getByRole('button', { name: 'Review withdrawal', exact: true })).toBeDisabled();
    const afterResponse = responseAt(page, '/balances', 'GET');
    await page.getByRole('button', { name: 'Refresh balances', exact: true }).click();
    const after = await (await afterResponse).json();
    expect(after.claimableAtoms).toBe('0');
    expect(BigInt(after.withdrawnAtoms)).toBeGreaterThan(BigInt(before.withdrawnAtoms));
    expect(after.walletBalanceAtoms).toMatch(/^\d+$/);
    expect(after.block.hash).toMatch(/^0x[0-9a-f]{64}$/i);
    await testInfo.attach('withdrawal-balances.json', { body: JSON.stringify({ before, after }, null, 2), contentType: 'application/json' });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('local-chain-workspace.png'), fullPage: true, animations: 'disabled' });
  });

  expect(errors, 'No uncaught browser exceptions in the wallet lifecycle').toEqual([]);
  await testInfo.attach('wallet-methods.json', { body: JSON.stringify({ methods: wallet.calls.map(call => call.method), broadcasts: wallet.broadcasts }, null, 2), contentType: 'application/json' });
});
