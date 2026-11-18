import { isAddress, type Address } from 'viem';
import type { MeNetworkConfig } from './config.js';
import { ME_SDK_REVISION, MeConfigurationError } from './config.js';
import type { FetchLike } from './rpc.js';

/** Paths and enum vocabulary verified in the official SDK at this immutable revision.
 * https://github.com/openmetaearth/meta-earth-js-sdk/blob/a56f3e936396de8689c2fc8667ad7306765eee9f/src/api/identity.ts
 * This is an independent read-only implementation; no vendor implementation is copied.
 */
export const IDENTITY_SOURCE_REVISION = ME_SDK_REVISION;
export class MeIdentityProtocolError extends Error { override name = 'MeIdentityProtocolError'; }
export class MeIdentityRejectedError extends Error { override name = 'MeIdentityRejectedError'; }
export interface MeIdentityRecord {
  did: string; address: string; pubkey: string; status: 0 | 1; kycLevel: number; subAccount: string;
}
const kycNames = ['KYC_LEVEL_NONE', 'KYC_LEVEL_ONE', 'KYC_LEVEL_TWO', 'KYC_LEVEL_THREE', 'KYC_LEVEL_FOUR', 'KYC_LEVEL_FIVE'] as const;
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function parseInfo(response: unknown): MeIdentityRecord | null {
  if (!object(response) || !('info' in response)) throw new MeIdentityProtocolError('Unexpected ME identity response envelope');
  if (response.info === null) return null;
  if (!object(response.info)) throw new MeIdentityProtocolError('Malformed ME identity info');
  const info = response.info;
  if (info.did === '') return null;
  if (typeof info.did !== 'string' || !info.did || typeof info.address !== 'string' || !info.address.startsWith('me1') || typeof info.pubkey !== 'string') throw new MeIdentityProtocolError('Missing or malformed canonical ME identity fields');
  const status = info.status === 1 || info.status === 'DID_STATUS_ACTIVE' ? 1 : info.status === 0 || info.status === 'DID_STATUS_INACTIVE' ? 0 : null;
  const level = typeof info.kycLevel === 'number' && Number.isInteger(info.kycLevel) ? info.kycLevel : kycNames.indexOf(info.kycLevel as typeof kycNames[number]);
  if (status === null || level < 0 || level > 5) throw new MeIdentityProtocolError('Unknown ME DID status/KYC enum; policy must not infer validity');
  const subAccount = info.subAccount ?? info.sub_account;
  if (typeof subAccount !== 'string') throw new MeIdentityProtocolError('Missing bound sub-account field');
  return { did: info.did, address: info.address, pubkey: info.pubkey, status, kycLevel: level, subAccount };
}

async function query(config: MeNetworkConfig, path: string, parameter: string, value: string, fetchImpl: FetchLike): Promise<MeIdentityRecord | null> {
  if (!config.cosmosRestUrl) throw new MeConfigurationError('ME_COSMOS_REST_URL is required for ME ID reads');
  if (!value || value.length > 512) throw new MeIdentityProtocolError('Invalid identity query input');
  const url = new URL(`${config.cosmosRestUrl}${path}`);
  url.searchParams.set(parameter, value);
  const response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000), redirect: 'error' });
  const text = await response.text();
  if (text.length > 1_000_000) throw new MeIdentityProtocolError('ME identity response exceeds size limit');
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new MeIdentityProtocolError('ME identity response is not JSON'); }
  if (!response.ok) {
    // These missing-record messages are explicitly handled by the official SDK.
    const message = object(body) && typeof body.message === 'string' ? body.message : '';
    if (message.includes('DID not found') || message.includes('failed to get DID by sub-account')) return null;
    throw new MeIdentityProtocolError(`ME identity HTTP ${response.status}`);
  }
  return parseInfo(body);
}
export const getMeIdByAddress = (config: MeNetworkConfig, address: string, fetchImpl: FetchLike = fetch) => query(config, '/metaearth/did/did', 'address', address, fetchImpl);
export const getMeIdByDid = (config: MeNetworkConfig, did: string, fetchImpl: FetchLike = fetch) => query(config, '/metaearth/did/didInfo', 'did', did, fetchImpl);
export const getMeIdBySubAccount = (config: MeNetworkConfig, subAccount: string, fetchImpl: FetchLike = fetch) => query(config, '/metaearth/kyc/QuerySubAccountDidResponse', 'sub_account', subAccount, fetchImpl);

/** Call only AFTER verifying a one-use wallet-control challenge. Never publish this result.
 * A returned record is not proof of skill, liveness, honesty, or absence of AI assistance.
 * No signature attestation is issued by this function; that is a separately authorized service.
 */
export async function verifyMeIdentityForWallet(config: MeNetworkConfig, wallet: Address, fetchImpl: FetchLike = fetch) {
  if (!isAddress(wallet)) throw new MeIdentityRejectedError('Invalid EVM wallet');
  if (config.minimumKycLevel === undefined || !config.identityPolicyReference) throw new MeConfigurationError('Official KYC level mapping and ME_ID_POLICY_REFERENCE are required before admission');
  const sub = await getMeIdBySubAccount(config, wallet, fetchImpl);
  if (!sub || sub.status !== 1 || sub.kycLevel < config.minimumKycLevel || sub.subAccount.toLowerCase() !== wallet.toLowerCase()) throw new MeIdentityRejectedError('ME identity does not satisfy the configured wallet/active/KYC policy');
  const main = await getMeIdByAddress(config, sub.address, fetchImpl);
  if (!main || main.did !== sub.did || main.address !== sub.address || main.pubkey !== sub.pubkey || main.subAccount.toLowerCase() !== wallet.toLowerCase() || main.status !== 1 || main.kycLevel !== sub.kycLevel) throw new MeIdentityRejectedError('ME main/sub-account binding could not be consistently verified');
  return { canonicalDid: main.did, mainAddress: main.address, wallet, kycLevel: main.kycLevel, observedAt: new Date().toISOString(), policyReference: config.identityPolicyReference, sourceRevision: IDENTITY_SOURCE_REVISION };
}
