import { readFileSync } from 'node:fs';
import { isAddress, getAddress, type Address, type Hex, type LocalAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadMeConfig, type MeNetworkConfig } from '../../../packages/me/src/config.js';
import { createMePublicClient, type DeploymentConfig, type MePublicClient } from '../../../packages/me/src/chain.js';
import { verifyMeIdentityForWallet } from '../../../packages/me/src/identity.js';

export type IdentityEvidence = {
  canonicalDid: string; wallet: Address; kycLevel: number; observedAt: string;
  policyReference: string; sourceRevision?: string; localTest?: boolean;
};
export type LiveSettings = {
  network: MeNetworkConfig;
  deployment: DeploymentConfig;
  client: MePublicClient;
  signers: { quote?: LocalAccount; assignment?: LocalAccount; delivery?: LocalAccount };
  reviewers: Address[];
  identitySecret: string;
  reviewerFeeWei: bigint;
  platformFeeWei: bigint;
  unitsVerified: boolean;
  unitEvidenceReference?: string;
  publicRpcUrl?: string;
  identityVerifier: (wallet: Address) => Promise<IdentityEvidence>;
  syncIntervalMs?: number;
  gasCharging?: 'exact-wei' | 'me-bank-ceil-prepay-floor-refund';
};

const account = (value: string | undefined) => {
  if (!value) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('Invalid attestation key configuration');
  return privateKeyToAccount(value as Hex);
};
const integer = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} must be an explicit unsigned decimal integer`);
  return BigInt(value);
};
export function loadLiveSettings(env: NodeJS.ProcessEnv = process.env): LiveSettings {
  const network = loadMeConfig(env);
  if (network.network === 'me-mainnet' && env.ME_ENABLE_MAINNET !== 'true') throw new Error('Mainnet requires an explicit separate enablement');
  if (!env.ME_DEPLOYMENT_FILE) throw new Error('ME_DEPLOYMENT_FILE is required');
  const manifest = JSON.parse(readFileSync(env.ME_DEPLOYMENT_FILE, 'utf8'));
  const raw = manifest.deployment ?? manifest;
  for (const name of ['escrow', 'registry']) if (!isAddress(raw[name])) throw new Error(`Invalid ${name} deployment address`);
  const deployment: DeploymentConfig = { ...raw, escrow: getAddress(raw.escrow), registry: getAddress(raw.registry), fromBlock: integer(String(raw.fromBlock), 'fromBlock'), confirmations: Number(raw.confirmations) };
  if (manifest.chainId !== undefined && manifest.chainId !== network.chainId) throw new Error('Deployment manifest belongs to another chain');
  const signers = { quote: account(env.ME_QUOTE_SIGNER_KEY), assignment: account(env.ME_ASSIGNMENT_SIGNER_KEY), delivery: account(env.ME_DELIVERY_GATE_KEY) };
  const reviewers = (env.ME_REVIEWER_WALLETS ?? '').split(',').map(s => s.trim()).filter(Boolean).map(s => {
    if (!isAddress(s)) throw new Error('Invalid invited reviewer address'); return getAddress(s);
  });
  const identitySecret = env.ME_ID_HASH_SECRET ?? '';
  if (identitySecret.length < 32) throw new Error('ME_ID_HASH_SECRET requires at least 32 random characters');
  const reviewerFeeWei = integer(env.ME_REVIEWER_FEE_WEI, 'ME_REVIEWER_FEE_WEI');
  const platformFeeWei = integer(env.ME_PLATFORM_FEE_WEI, 'ME_PLATFORM_FEE_WEI');
  if (reviewerFeeWei === 0n || reviewerFeeWei % network.quantumWei !== 0n || platformFeeWei % network.quantumWei !== 0n) throw new Error('Configured fees must preserve the verified monetary quantum');
  let unitsVerified = network.network === 'local';
  if (env.ME_UNIT_VERIFICATION_FILE) {
    const evidence = JSON.parse(readFileSync(env.ME_UNIT_VERIFICATION_FILE, 'utf8'));
    unitsVerified = evidence.schema === 'humandock.units.v1' && evidence.status === 'matched' && evidence.nonZero === true
      && evidence.chainId === network.chainId && evidence.bankDenom === network.bankDenom
      && evidence.bankDecimals === network.bankDecimals && evidence.evmDecimals === 18
      && evidence.quantumWei === network.quantumWei.toString();
    if (!unitsVerified) throw new Error('Unit evidence does not match the configured network and nonzero balance comparison');
  }
  let publicRpcUrl = env.ME_PUBLIC_RPC_URL || (network.network === 'local' ? network.rpcUrl : undefined);
  if (publicRpcUrl) {
    const url = new URL(publicRpcUrl);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(network.network === 'local' && url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw new Error('Invalid public wallet RPC URL');
  }
  return { network, deployment, client: createMePublicClient(network), signers, reviewers, identitySecret, reviewerFeeWei, platformFeeWei, unitsVerified,
    unitEvidenceReference: env.ME_UNIT_VERIFICATION_FILE, publicRpcUrl, identityVerifier: wallet => verifyMeIdentityForWallet(network, wallet),
    syncIntervalMs: 10_000, gasCharging: env.ME_GAS_ACCOUNTING === 'exact-wei' && network.network === 'local' ? 'exact-wei' : env.ME_GAS_ACCOUNTING === 'me-bank-ceil-prepay-floor-refund' ? 'me-bank-ceil-prepay-floor-refund' : undefined };
}
