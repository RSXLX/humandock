import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { isAddress, type Address } from 'viem';
import { loadMeConfig } from '../packages/me/src/config.js';
import { createMePublicClient } from '../packages/me/src/chain.js';
import { verifyMeUnits } from '../packages/me/src/bank.js';

try {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadMeConfig(process.env);
  const address = process.env.ME_UNIT_PROBE_ADDRESS;
  if (!address || !isAddress(address)) throw new Error('ME_UNIT_PROBE_ADDRESS must explicitly identify a public nonzero EVM account to read');
  const height = process.env.ME_UNIT_PROBE_BLOCK || undefined;
  if (height !== undefined && !/^(0|[1-9][0-9]*)$/.test(height)) throw new Error('ME_UNIT_PROBE_BLOCK must be a decimal block height');
  const report = await verifyMeUnits(createMePublicClient(config), config, address as Address, { blockNumber: height === undefined ? undefined : BigInt(height) });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex !== -1) {
    const path = process.argv[outputIndex + 1];
    if (!path || path.startsWith('--')) throw new Error('--output requires a file path');
    await writeFile(path, json, { flag: 'wx' });
  }
  process.stdout.write(json);
  if (report.status !== 'matched') process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ schema: 'humandock.units.v1', status: 'unverified', liveWritesEnabled: false, error: error instanceof Error ? error.message : 'Unit verification failed' }));
  process.exitCode = 1;
}
