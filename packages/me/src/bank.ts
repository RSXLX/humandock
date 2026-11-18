import { bytesToHex, hexToBytes, isAddress, type Address, type Hex } from 'viem';
import type { MeNetworkConfig } from './config.js';
import { MeConfigurationError } from './config.js';
import { MeChainError, type MePublicClient } from './chain.js';
import type { FetchLike } from './rpc.js';
import type { BankBalanceEvidence, BankBalanceReader } from './balances.js';

// Minimal Bech32 (not Bech32m) address codec. It does not establish ME ID ownership.
const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values: number[]) {
  let checksum = 1;
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  for (const value of values) { const high = checksum >>> 25; checksum = ((checksum & 0x1ffffff) << 5) ^ value; for (let i = 0; i < 5; i++) if ((high >>> i) & 1) checksum ^= generators[i]; }
  return checksum >>> 0;
}
const expandedPrefix = (prefix: string) => [...prefix].map((c) => c.charCodeAt(0) >>> 5).concat([0], [...prefix].map((c) => c.charCodeAt(0) & 31));
function convertBits(data: number[], from: number, to: number, pad: boolean) {
  let accumulator = 0; let bits = 0; const result: number[] = []; const mask = (1 << to) - 1;
  for (const value of data) { if (value < 0 || value >>> from) throw new Error('Invalid Bech32 word'); accumulator = ((accumulator << from) | value) & ((1 << (from + to - 1)) - 1); bits += from; while (bits >= to) { bits -= to; result.push((accumulator >>> bits) & mask); } }
  if (pad) { if (bits) result.push((accumulator << (to - bits)) & mask); }
  else if (bits >= from || ((accumulator << (to - bits)) & mask)) throw new Error('Invalid Bech32 padding');
  return result;
}
export function evmToBankAddress(address: Address): string {
  if (!isAddress(address)) throw new MeChainError('INVALID_ADDRESS', 'Expected 20-byte EVM address');
  const words = convertBits([...hexToBytes(address)], 8, 5, true);
  const sum = polymod([...expandedPrefix('me'), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (sum >>> (5 * (5 - i))) & 31);
  return `me1${[...words, ...checksum].map((value) => alphabet[value]).join('')}`;
}
export function bankAddressToEvm(address: string): Address {
  if (address !== address.toLowerCase() || !address.startsWith('me1') || address.length !== 41) throw new MeChainError('INVALID_BANK_ADDRESS', 'Expected canonical lowercase me Bech32 account address');
  const words = [...address.slice(3)].map((c) => alphabet.indexOf(c));
  if (words.some((word) => word < 0) || polymod([...expandedPrefix('me'), ...words]) !== 1) throw new MeChainError('INVALID_BANK_ADDRESS', 'Invalid me Bech32 checksum');
  let bytes: number[];
  try { bytes = convertBits(words.slice(0, -6), 5, 8, false); } catch { throw new MeChainError('INVALID_BANK_ADDRESS', 'Invalid me Bech32 encoding'); }
  if (bytes.length !== 20) throw new MeChainError('INVALID_BANK_ADDRESS', 'Bank account does not encode exactly 20 bytes');
  return bytesToHex(new Uint8Array(bytes)) as Address;
}

export function cosmosResponseHeight(headers: Headers): bigint | undefined {
  const values = [headers.get('x-cosmos-block-height'), headers.get('grpc-metadata-x-cosmos-block-height')].filter((value): value is string => value !== null);
  if (!values.length) return undefined;
  if (values.some((value) => !/^(0|[1-9][0-9]*)$/.test(value)) || values.some((value) => value !== values[0])) throw new MeChainError('COSMOS_HEIGHT_MISMATCH', 'Conflicting or malformed Cosmos response height headers');
  return BigInt(values[0]);
}
export async function cosmosGet(config: MeNetworkConfig, path: string, options: { height?: bigint; fetchImpl?: FetchLike } = {}) {
  if (!config.cosmosRestUrl) throw new MeConfigurationError('ME_COSMOS_REST_URL is required');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.height !== undefined) headers['x-cosmos-block-height'] = options.height.toString();
  const response = await (options.fetchImpl ?? fetch)(`${config.cosmosRestUrl}${path}`, { method: 'GET', headers, signal: AbortSignal.timeout(15_000), redirect: 'error' });
  const text = await response.text();
  if (text.length > 2_000_000) throw new MeChainError('COSMOS_RESPONSE_TOO_LARGE', 'Cosmos response exceeds limit');
  let body: any;
  try { body = JSON.parse(text); } catch { throw new MeChainError('COSMOS_PROTOCOL', 'Cosmos response is not JSON'); }
  if (!response.ok) throw new MeChainError('COSMOS_HTTP', `Cosmos query returned HTTP ${response.status}`);
  return { body, height: cosmosResponseHeight(response.headers), url: `${config.cosmosRestUrl}${path}` };
}

/** Official Ethermint CosmosAccount query; same bytes alone are not a DID binding. */
export async function getEvmBankAccount(config: MeNetworkConfig, wallet: Address, options: { height?: bigint; fetchImpl?: FetchLike } = {}) {
  if (!isAddress(wallet)) throw new MeChainError('INVALID_ADDRESS', 'Expected EVM account');
  const result = await cosmosGet(config, `/ethermint/evm/v1/cosmos_account/${wallet}`, options);
  const bankAddress = result.body?.cosmos_address;
  if (typeof bankAddress !== 'string' || bankAddressToEvm(bankAddress).toLowerCase() !== wallet.toLowerCase()) throw new MeChainError('BANK_MAPPING_MISMATCH', 'CosmosAccount response does not map to the same EVM account bytes');
  if (options.height !== undefined && result.height !== options.height) throw new MeChainError('COSMOS_HEIGHT_UNVERIFIED', 'CosmosAccount did not attest the requested response height');
  return { evmAddress: wallet, bankAddress, observedHeight: result.height, source: result.url };
}

async function readCosmosBlockHash(config: MeNetworkConfig, height: bigint, fetchImpl?: FetchLike) {
  const result = await cosmosGet(config, `/cosmos/base/tendermint/v1beta1/blocks/${height}`, { fetchImpl });
  const header = result.body?.block?.header ?? result.body?.sdk_block?.header;
  const encoded = result.body?.block_id?.hash;
  if (header?.height !== height.toString() || typeof encoded !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new MeChainError('COSMOS_BLOCK_UNVERIFIED', 'Cosmos block height/hash is malformed');
  return bytesToHex(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
}

export function createCosmosBankReader(config: MeNetworkConfig, fetchImpl: FetchLike = fetch): BankBalanceReader {
  return async ({ address, blockNumber, blockHash }): Promise<BankBalanceEvidence> => {
    const mapping = await getEvmBankAccount(config, address, { height: blockNumber, fetchImpl });
    const [balance, cosmosBlockHash] = await Promise.all([
      cosmosGet(config, `/cosmos/bank/v1beta1/balances/${mapping.bankAddress}/by_denom?denom=${encodeURIComponent(config.bankDenom)}`, { height: blockNumber, fetchImpl }),
      readCosmosBlockHash(config, blockNumber, fetchImpl),
    ]);
    const coin = balance.body?.balance;
    if (coin?.denom !== config.bankDenom || typeof coin.amount !== 'string' || !/^(0|[1-9][0-9]*)$/.test(coin.amount)) throw new MeChainError('BANK_PROTOCOL', 'Bank balance does not match the configured denomination');
    return { evmAddress: address, bankAddress: mapping.bankAddress, denom: coin.denom, amountAtoms: BigInt(coin.amount), blockNumber, blockHash: cosmosBlockHash, heightVerified: balance.height === blockNumber && cosmosBlockHash.toLowerCase() === blockHash.toLowerCase(), mappingVerified: true, evidenceReference: `${mapping.source} ; ${balance.url} @ ${blockNumber}` };
  };
}

export interface UnitVerificationReport {
  schema: 'humandock.units.v1'; chainId: number; network: MeNetworkConfig['network'];
  bankDenom: string; bankDecimals: number; evmDecimals: 18; quantumWei: string;
  blockNumber: string; blockHash: Hex; status: 'matched' | 'mismatch' | 'unverified'; nonZero: boolean;
  observedAt: string; liveWritesEnabled: false; evidence: Record<string, unknown>; issues: string[];
}
export async function verifyMeUnits(client: MePublicClient, config: MeNetworkConfig, address: Address, options: { blockNumber?: bigint; fetchImpl?: FetchLike } = {}): Promise<UnitVerificationReport> {
  const chainId = await client.getChainId();
  if (chainId !== config.chainId) throw new MeChainError('CHAIN_MISMATCH', 'Unit evidence RPC has the wrong chain ID');
  const block = options.blockNumber === undefined ? await client.getBlock() : await client.getBlock({ blockNumber: options.blockNumber });
  const [evmWei, bank, metadata] = await Promise.all([
    client.getBalance({ address, blockNumber: block.number }),
    createCosmosBankReader(config, options.fetchImpl)({ address, blockNumber: block.number, blockHash: block.hash }),
    cosmosGet(config, `/cosmos/bank/v1beta1/denoms_metadata/${encodeURIComponent(config.bankDenom)}`, { height: block.number, fetchImpl: options.fetchImpl }),
  ]);
  const denomMetadata = metadata.body?.metadata;
  const base = denomMetadata?.denom_units?.find((unit: any) => unit.denom === config.bankDenom);
  const display = denomMetadata?.denom_units?.find((unit: any) => unit.denom === denomMetadata.display);
  const issues: string[] = [];
  if (denomMetadata?.base !== config.bankDenom || base?.exponent !== 0 || display?.exponent !== config.bankDecimals) issues.push('DENOM_METADATA_MISMATCH');
  if (!bank.heightVerified || !bank.mappingVerified || metadata.height !== block.number) issues.push('HISTORICAL_HEIGHT_UNVERIFIED');
  if (bank.amountAtoms * config.quantumWei !== evmWei) issues.push('BANK_EVM_QUANTUM_MISMATCH');
  const nonZero = bank.amountAtoms > 0n && evmWei > 0n;
  if (!nonZero) issues.push('ZERO_BALANCE_CANNOT_VERIFY_RATIO');
  const canonical = await client.getBlock({ blockNumber: block.number });
  if (canonical.hash.toLowerCase() !== block.hash.toLowerCase()) issues.push('BLOCK_REORGANIZED');
  return { schema: 'humandock.units.v1', chainId, network: config.network, bankDenom: config.bankDenom, bankDecimals: config.bankDecimals, evmDecimals: 18, quantumWei: config.quantumWei.toString(), blockNumber: block.number.toString(), blockHash: block.hash, status: issues.some((issue) => issue.includes('MISMATCH')) ? 'mismatch' : issues.length ? 'unverified' : 'matched', nonZero, observedAt: new Date().toISOString(), liveWritesEnabled: false, evidence: { mode: config.network === 'local' ? 'local-fixture' : 'read-only-network', evmAddress: address, bankAddress: bank.bankAddress, evmWei: evmWei.toString(), bankAtoms: bank.amountAtoms.toString(), bankResponseHeightVerified: bank.heightVerified, cosmosBlockHash: bank.blockHash, sameAccountMappingVerified: bank.mappingVerified, metadataResponseHeight: metadata.height?.toString() ?? null, metadata: denomMetadata, evmRpcUrl: config.rpcUrl, cosmosRestUrl: config.cosmosRestUrl, source: bank.evidenceReference }, issues };
}
