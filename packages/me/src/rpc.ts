import type { MeNetworkConfig } from './config.js';

export class MeRpcError extends Error { override name = 'MeRpcError'; }
export type FetchLike = typeof fetch;

/** Read-only by construction. This module never accepts a private key or raw transaction. */
export async function probeMeRpc(config: MeNetworkConfig, fetchImpl: FetchLike = fetch) {
  let nextId = 0;
  async function read(method: 'eth_chainId' | 'web3_clientVersion' | 'eth_getBlockByNumber', params: unknown[]) {
    const id = ++nextId;
    const response = await fetchImpl(config.rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(8_000), redirect: 'error',
    });
    if (!response.ok) throw new MeRpcError(`RPC HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 2_000_000) throw new MeRpcError('RPC response exceeds size limit');
    let body: any;
    try { body = JSON.parse(text); } catch { throw new MeRpcError('RPC returned invalid JSON'); }
    if (body?.jsonrpc !== '2.0' || body.id !== id || body.error || !('result' in body)) throw new MeRpcError(`Invalid RPC response for ${method}`);
    return body.result as unknown;
  }
  const [chainIdRaw, clientVersion, block] = await Promise.all([
    read('eth_chainId', []), read('web3_clientVersion', []), read('eth_getBlockByNumber', ['latest', false]),
  ]);
  if (typeof chainIdRaw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(chainIdRaw)) throw new MeRpcError('Malformed eth_chainId');
  if (BigInt(chainIdRaw) !== BigInt(config.chainId)) throw new MeRpcError(`RPC chainId does not match configured ME_EVM_CHAIN_ID ${config.chainId}`);
  if (typeof clientVersion !== 'string' || !clientVersion) throw new MeRpcError('Malformed web3_clientVersion');
  const b = block as Record<string, unknown> | null;
  if (!b || typeof b.number !== 'string' || !/^0x[0-9a-fA-F]+$/.test(b.number) || typeof b.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(b.hash)) throw new MeRpcError('Malformed latest block');
  return {
    network: config.network, actualChainId: config.chainId,
    blockNumber: BigInt(b.number).toString(), blockHash: b.hash,
    clientVersion, observedAt: new Date().toISOString(),
    configuredUnits: { nativeSymbol: config.nativeSymbol, evmDecimals: 18, bankDenom: config.bankDenom, bankDecimals: config.bankDecimals, quantumWei: config.quantumWei.toString() },
    unitsVerifiedOnLiveChain: false as const,
    identityVerified: false as const,
    liveWritesEnabled: false as const,
    verificationStatus: 'RPC_ONLY_NOT_DEPLOYMENT_VERIFICATION' as const,
  };
}
