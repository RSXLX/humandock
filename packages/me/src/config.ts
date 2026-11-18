/** Explicit configuration only: source-code defaults are not live-network evidence. */
export interface MeNetworkConfig {
  network: 'local' | 'me-testnet' | 'me-mainnet';
  rpcUrl: string;
  chainId: number;
  nativeSymbol: string;
  evmDecimals: 18;
  bankDenom: string;
  bankDecimals: number;
  quantumWei: bigint;
  cosmosRestUrl?: string;
  minimumKycLevel?: number;
  identityPolicyReference?: string;
}

export class MeConfigurationError extends Error { override name = 'MeConfigurationError'; }
export const ME_SDK_REVISION = 'a56f3e936396de8689c2fc8667ad7306765eee9f';
export const ME_HUB_REVISION = '1e9eff8a5feae166fe9d72ad4bcc904622b078a1';
export const ETHERMINT_UNIT_REVISION = '08a9eaaee040';
export const SOURCE_CANDIDATE_QUANTUM_WEI = 10_000_000_000n;

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (value === undefined || value.length === 0 || value !== value.trim()) throw new MeConfigurationError(`${key} must be set explicitly without surrounding whitespace`);
  return value;
}
function decimalInteger(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new MeConfigurationError(`${label} must be an unsigned decimal integer`);
  return BigInt(value);
}
function endpoint(raw: string, network: MeNetworkConfig['network'], label: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new MeConfigurationError(`${label} must be an absolute URL`); }
  if (url.username || url.password || url.hash || url.search) throw new MeConfigurationError(`${label} must not contain userinfo, query parameters or fragments`);
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(network === 'local' && isLoopback && url.protocol === 'http:')) throw new MeConfigurationError(`${label} requires HTTPS (HTTP is allowed only for local loopback)`);
  return url.toString().replace(/\/$/, '');
}

export function loadMeConfig(env: Record<string, string | undefined>): MeNetworkConfig {
  const network = required(env, 'ME_NETWORK');
  if (!['local', 'me-testnet', 'me-mainnet'].includes(network)) throw new MeConfigurationError('ME_NETWORK must be local, me-testnet or me-mainnet');
  const mode = network as MeNetworkConfig['network'];
  const chainIdBig = decimalInteger(required(env, 'ME_EVM_CHAIN_ID'), 'ME_EVM_CHAIN_ID');
  if (chainIdBig === 0n || chainIdBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new MeConfigurationError('ME_EVM_CHAIN_ID is outside the supported integer range');
  const bankDecimalsBig = decimalInteger(required(env, 'ME_BANK_DECIMALS'), 'ME_BANK_DECIMALS');
  if (bankDecimalsBig > 18n) throw new MeConfigurationError('Bank decimals must be between 0 and 18 for this adapter');
  const quantumWei = decimalInteger(required(env, 'ME_QUANTUM_WEI'), 'ME_QUANTUM_WEI');
  if (quantumWei !== 10n ** (18n - bankDecimalsBig)) throw new MeConfigurationError('ME_QUANTUM_WEI must equal 10^(18 - ME_BANK_DECIMALS); verify the live mapping before using it');
  const nativeSymbol = required(env, 'ME_NATIVE_SYMBOL');
  const bankDenom = required(env, 'ME_BANK_DENOM');
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(nativeSymbol) || !/^[A-Za-z0-9/_.:-]{1,128}$/.test(bankDenom)) throw new MeConfigurationError('Invalid native symbol or bank denom');
  let minimumKycLevel: number | undefined;
  if (env.ME_MIN_KYC_LEVEL !== undefined && env.ME_MIN_KYC_LEVEL !== '') {
    const value = decimalInteger(required(env, 'ME_MIN_KYC_LEVEL'), 'ME_MIN_KYC_LEVEL');
    if (value < 1n || value > 5n) throw new MeConfigurationError('ME_MIN_KYC_LEVEL must be 1..5; advanced verification mapping requires official confirmation');
    minimumKycLevel = Number(value);
  }
  return {
    network: mode, rpcUrl: endpoint(required(env, 'ME_EVM_RPC_URL'), mode, 'ME_EVM_RPC_URL'),
    chainId: Number(chainIdBig), nativeSymbol, evmDecimals: 18, bankDenom,
    bankDecimals: Number(bankDecimalsBig), quantumWei,
    cosmosRestUrl: env.ME_COSMOS_REST_URL ? endpoint(env.ME_COSMOS_REST_URL, mode, 'ME_COSMOS_REST_URL') : undefined,
    minimumKycLevel, identityPolicyReference: env.ME_ID_POLICY_REFERENCE?.trim() || undefined,
  };
}

export function bankAtomsToWei(bankAtoms: bigint, config: MeNetworkConfig): bigint {
  if (bankAtoms < 0n) throw new MeConfigurationError('Negative bank amount');
  return bankAtoms * config.quantumWei;
}
export function weiToBankAtoms(amountWei: bigint, config: MeNetworkConfig): bigint {
  if (amountWei < 0n || amountWei % config.quantumWei !== 0n) throw new MeConfigurationError('Amount would lose precision in the bank/EVM conversion');
  return amountWei / config.quantumWei;
}
