import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createWalletClient, http, isAddress, keccak256, type Address, type Hex } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { compileContracts } from './compile-contracts.js';
import { loadMeConfig } from '../packages/me/src/config.js';
import { createMePublicClient, type RoleAddresses } from '../packages/me/src/chain.js';
import { deployHumanDock, stringifyChainData } from '../packages/me/src/deployment.js';

// No deployment occurs without --execute. Never invoke remote execution as an automatic startup step.
function argument(name: string) { const index = process.argv.indexOf(name); return index === -1 ? undefined : process.argv[index + 1]; }
try {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadMeConfig(process.env);
  const roleEnv = { owner: 'ME_OWNER_ADDRESS', quoteSigner: 'ME_QUOTE_SIGNER_ADDRESS', assignmentSigner: 'ME_ASSIGNMENT_SIGNER_ADDRESS', deliveryGate: 'ME_DELIVERY_GATE_ADDRESS', arbitrator: 'ME_ARBITRATOR_ADDRESS', platformRecipient: 'ME_PLATFORM_RECIPIENT_ADDRESS' } as const;
  const roles = Object.fromEntries(Object.entries(roleEnv).map(([role, key]) => {
    const value = process.env[key]; if (!value || !isAddress(value)) throw new Error(`${key} must explicitly identify the deployment role`); return [role, value];
  })) as unknown as RoleAddresses;
  const cap = process.env.ME_MAX_TASK_FEE_WEI;
  const confirmationsText = process.env.ME_CONFIRMATIONS;
  if (!cap || !/^[1-9][0-9]*$/.test(cap)) throw new Error('ME_MAX_TASK_FEE_WEI must be an explicit positive decimal integer');
  if (!confirmationsText || !/^[1-9][0-9]*$/.test(confirmationsText)) throw new Error('ME_CONFIRMATIONS must be explicitly configured');
  const confirmations = Number(confirmationsText);
  const artifacts = await compileContracts(false);
  const outputPath = argument('--output') || process.env.ME_DEPLOYMENT_FILE || '.data/me-deployment.json';
  if(outputPath.startsWith('--'))throw new Error('--output requires a file path');
  const execute = process.argv.includes('--execute');
  if (!execute) {
    console.log(stringifyChainData({ mode: 'plan-only', transactionsSent: false, network: config.network, chainId: config.chainId, quantumWei: config.quantumWei, maxTaskFeeWei: cap, confirmations, roles, evmVersion: 'paris', creationCodeHashes: { escrow: keccak256(artifacts.ReviewEscrow.bytecode), registry: keccak256(artifacts.ReleaseRegistry.bytecode) }, outputPath }));
  } else {
    if (existsSync(outputPath)) throw new Error('Output manifest already exists; select a new path before deploying another contract set');
    if (config.network !== 'local' && argument('--ack-chain-id') !== config.chainId.toString()) throw new Error('Remote execution requires --ack-chain-id matching the explicitly configured network');
    const privateKey = process.env.ME_DEPLOYER_PRIVATE_KEY;
    if (config.network !== 'local' && (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey))) throw new Error('Remote execution requires an explicitly supplied ME_DEPLOYER_PRIVATE_KEY');
    // The fallback below is a publicly known LOCAL test mnemonic, never a ME funding source.
    const account = privateKey ? privateKeyToAccount(privateKey as Hex) : mnemonicToAccount('test test test test test test test test test test test junk');
    const client = createMePublicClient(config);
    const wallet = createWalletClient({ account, chain: client.chain, transport: http(config.rpcUrl, { timeout: 15_000 }) });
    const manifest = await deployHumanDock({ client, wallet, config, artifacts: { ReviewEscrow: artifacts.ReviewEscrow, ReleaseRegistry: artifacts.ReleaseRegistry }, roles, maxTaskFeeWei: BigInt(cap), confirmations, explicitRemoteAuthorization: config.network === 'local' ? undefined : { chainId: config.chainId, deployer: account.address as Address, acknowledgment: 'DEPLOY_REVIEWED_HUMANDOCK_CONTRACTS' } });
    const json = `${stringifyChainData(manifest)}\n`;
    console.log(json);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, json, { flag: 'wx' });
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Deployment preparation failed' }));
  process.exitCode = 1;
}
