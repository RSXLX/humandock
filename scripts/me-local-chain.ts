import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import ganache from 'ganache';
import { deployLocalFixture, LOCAL_TEST_MNEMONIC } from '../packages/me/src/local-fixture.js';
import { stringifyChainData } from '../packages/me/src/deployment.js';

// Isolated fake-currency chain. Never connect this helper to a remote ME endpoint.
const port = Number(process.env.ME_LOCAL_PORT ?? '18545');
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('ME_LOCAL_PORT must be 1024..65535');
const server = ganache.server({ logging: { quiet: true }, wallet: { mnemonic: LOCAL_TEST_MNEMONIC, totalAccounts: 12, defaultBalance: 1000 }, chain: { chainId: 31337, hardfork: 'merge' }, miner: { timestampIncrement: 'clock', blockTime: 1 } });
try {
  await server.listen(port, '127.0.0.1');
  const fixture = await deployLocalFixture({ provider: server.provider as any });
  const output = process.env.ME_DEPLOYMENT_FILE ?? '.data/local-me/deployment.json';
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${stringifyChainData(fixture.deployment)}\n`);
  console.log(stringifyChainData({ label: 'local_test', realME: false, currency: 'LOCAL (no value)', rpcUrl: `http://127.0.0.1:${port}`, chainId: 31337, deploymentFile: output, deployment: fixture.deployment, buyer: fixture.buyer.address, reviewer: fixture.reviewer.address, accountDerivation: 'Public local test mnemonic; account indices: owner0, quote1, assignment2, gate3, arbiter4, platform5, buyer6, reviewer7, keeper8', testMnemonic: LOCAL_TEST_MNEMONIC }));
  const stop = async () => { await server.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} catch (error) {
  await server.close();
  console.error(error instanceof Error ? error.message : 'Local chain failed');
  process.exitCode = 1;
}
