import { loadMeConfig, ME_SDK_REVISION, ME_HUB_REVISION, ETHERMINT_UNIT_REVISION } from '../packages/me/src/config.js';
import { probeMeRpc } from '../packages/me/src/rpc.js';
import { existsSync } from 'node:fs';

try {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadMeConfig(process.env);
  const result = await probeMeRpc(config);
  console.log(JSON.stringify({
    ...result,
    sources: { sdkRevision: ME_SDK_REVISION, hubRevision: ME_HUB_REVISION, ethermintUnitRevision: ETHERMINT_UNIT_REVISION },
    remainingGates: ['Official event network acceptance', 'Bank/EVM unit and native asset mapping', 'External-wallet typed signatures', 'Official advanced-KYC mapping', 'Small deposit/split/withdraw reconciliation'],
    statement: 'Read-only RPC probe. No wallet signing key requested or used, transaction sent, contract deployed, or ME live integration approved.',
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, liveWritesEnabled: false, error: error instanceof Error ? error.message : 'ME preflight failed' }));
  process.exitCode = 1;
}
