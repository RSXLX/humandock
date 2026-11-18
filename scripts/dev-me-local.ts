import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ganache from 'ganache';
import { buildApp } from '../apps/api/src/server.js';
import { Database } from '../apps/api/src/storage.js';
import type { LiveSettings } from '../apps/api/src/live-config.js';
import { deployLocalFixture, LOCAL_TEST_MNEMONIC } from '../packages/me/src/local-fixture.js';
import { stringifyChainData } from '../packages/me/src/deployment.js';
import { MeIdentityRejectedError } from '../packages/me/src/identity.js';

/** Explicit LOCAL TEST runner: real wallet signatures and EVM transactions, synthetic identity fixture.
 * No environment switch in the production API enables this identity verifier.
 * All services share this process/child network namespace. No remote ME endpoint is contacted.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function port(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65535) throw new Error(`${name} must be 1024..65535`);
  return value;
}
const rpcPort = port('ME_LOCAL_PORT', 18545);
const apiPort = port('API_PORT', 4000);
const webPort = port('WEB_PORT', 3000);
if (new Set([rpcPort, apiPort, webPort]).size !== 3) throw new Error('Local RPC, API and web ports must be distinct');
const rpcUrl = `http://127.0.0.1:${rpcPort}`;
const apiUrl = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const chain = ganache.server({ logging: { quiet: true }, wallet: { mnemonic: LOCAL_TEST_MNEMONIC, totalAccounts: 12, defaultBalance: 1000 }, chain: { chainId: 31337, hardfork: 'merge' }, miner: { timestampIncrement: 'clock', blockTime: 1 } });
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let web: ChildProcess | undefined;
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (web && !web.killed) web.kill('SIGTERM');
  await app?.close().catch(() => undefined);
  await chain.close().catch(() => undefined);
  process.exitCode = code;
}

try {
  await chain.listen(rpcPort, '127.0.0.1');
  const fixture = await deployLocalFixture({ provider: chain.provider as any });
  const allowed = new Set(fixture.accounts.map((account) => account.address.toLowerCase()));
  const settings: LiveSettings = {
    network: { ...fixture.config, rpcUrl }, deployment: fixture.deployment, client: fixture.client,
    signers: { quote: fixture.quoteSigner, assignment: fixture.assignmentSigner, delivery: fixture.deliveryGateSigner },
    reviewers: [fixture.reviewer.address], identitySecret: randomBytes(32).toString('hex'),
    reviewerFeeWei: 1_000_000_000_000_000n, platformFeeWei: 200_000_000_000_000n,
    unitsVerified: true, unitEvidenceReference: 'explicit-local-evm-fixture; no real Cosmos bank',
    publicRpcUrl: rpcUrl, syncIntervalMs: 500, gasCharging: 'exact-wei',
    identityVerifier: async (wallet) => {
      if (!allowed.has(wallet.toLowerCase())) throw new MeIdentityRejectedError('This explicit local test fixture only admits its public Ganache accounts');
      return { canonicalDid: `local-test:${wallet.toLowerCase()}`, wallet, kycLevel: 1, observedAt: new Date().toISOString(), policyReference: 'explicit-local-test-fixture; not an ME identity assertion', localTest: true };
    },
  };
  // Never inherit DATABASE_URL: chain and database are deliberately reset together on each run.
  app = await buildApp({ mode: 'me', database: new Database({ dataDir: 'memory://' }), liveSettings: settings, logger: true, origins: [webUrl, `http://localhost:${webPort}`] });
  await app.listen({ host: '127.0.0.1', port: apiPort });
  const directory = resolve(root, '.data/local-me-runner');
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'deployment.json'), `${stringifyChainData(fixture.deployment)}\n`);
  const metadata = { label: 'local_test', realME: false, currency: 'LOCAL (no value)', rpcUrl, apiUrl, webUrl, chainId: 31337, deployment: fixture.deployment, buyer: fixture.buyer.address, reviewer: fixture.reviewer.address, accounts: fixture.accounts.map((account, index) => ({ index, address: account.address })), publicTestMnemonic: LOCAL_TEST_MNEMONIC, identity: 'explicit process-injected local fixture; wallet signatures are real; no ME identity claim', database: 'ephemeral in-memory PostgreSQL' };
  await writeFile(resolve(directory, 'fixture.json'), `${stringifyChainData(metadata)}\n`);
  web = spawn(process.execPath, [resolve(root, 'node_modules/next/dist/bin/next'), 'dev', '-H', '127.0.0.1', '-p', String(webPort)], { cwd: resolve(root, 'apps/web'), stdio: 'inherit', env: { ...process.env, APP_MODE: 'me', API_PROXY_ORIGIN: apiUrl, NEXT_TELEMETRY_DISABLED: '1' } });
  web.on('error', (error) => { console.error(`Next dev could not start: ${error.message}`); void stop(1); });
  web.on('exit', (code) => { if (!stopping) void stop(code ?? 1); });
  console.log(stringifyChainData({ label: 'local_test', realME: false, rpcUrl, apiUrl, webUrl, fixtureFile: resolve(directory, 'fixture.json'), buyer: fixture.buyer.address, reviewer: fixture.reviewer.address, identity: metadata.identity }));
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Local ME test runner failed');
  await stop(1);
}
