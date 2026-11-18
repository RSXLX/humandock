/** Browser wallet primitives. No method runs until its caller explicitly invokes it. */
export interface Eip1193Provider {
  request(args: { method: string; params?: readonly unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, handler: (...args: unknown[]) => void): unknown;
}
export type WalletChoice = { id: string; name: string; provider: Eip1193Provider; source: "eip6963" | "injected" };
export type WalletSnapshot = { address: string; chainId: number };
export type WalletChain = { chainId: string; chainName: string; nativeCurrency: { name: string; symbol: string; decimals: 18 }; rpcUrls: string[]; blockExplorerUrls?: string[] };
export type WalletTransaction = { from: string; to: string; data: string; value: string; chainId: number };
export type TypedData = { domain: Record<string, unknown>; primaryType: string; types: Record<string, { name: string; type: string }[]>; message: Record<string, unknown> };

export class WalletError extends Error {
  constructor(message: string, public code: string | number = "WALLET_ERROR") { super(message); this.name = "WalletError"; }
}
export const isAddress = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
export const sameAddress = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
export function chainHex(chainId: number): string {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new WalletError("The network returned an invalid chain ID.", "INVALID_CHAIN");
  return `0x${chainId.toString(16)}`;
}
export function parseChain(value: unknown): number {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) throw new WalletError("The wallet returned an invalid network ID.", "INVALID_CHAIN");
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new WalletError("The wallet network is unsupported.", "INVALID_CHAIN");
  return Number(parsed);
}
export function walletError(error: unknown): WalletError {
  if (error instanceof WalletError) return error;
  const candidate = error as { code?: number | string; message?: string } | null;
  const code = Number(candidate?.code);
  const messages: Record<number, string> = {
    4001: "You declined the wallet request. Nothing was sent by this request.",
    4100: "The wallet has not authorized this account. Connect it again.",
    4200: "This wallet does not support the requested method. Choose a compatible EVM wallet.",
    4900: "The wallet is disconnected. Reconnect before continuing.",
    4901: "The wallet is not connected to the required network. Switch networks explicitly.",
    4902: "This network is not in your wallet yet. Review its details before adding it.",
    [-32002]: "A request is already open in your wallet. Complete or reject that request first.",
  };
  return new WalletError(messages[code] || candidate?.message?.slice(0, 300) || "The wallet request failed. Check your wallet and retry.", Number.isFinite(code) ? code : "WALLET_ERROR");
}
function provider(value: unknown): value is Eip1193Provider { return Boolean(value && typeof value === "object" && typeof (value as Eip1193Provider).request === "function"); }

/** Discovery reads provider announcements only; it never requests accounts. */
export function discoverWallets(onChange: (choices: WalletChoice[]) => void): () => void {
  const choices: WalletChoice[] = [];
  function add(choice: WalletChoice) {
    const existing = choices.findIndex(item => item.provider === choice.provider);
    if (existing >= 0) {
      if (choice.source === "eip6963") choices[existing] = choice;
    } else if (choices.length < 12) choices.push(choice);
    onChange([...choices]);
  }
  const announce = (event: Event) => {
    const detail = (event as CustomEvent<{ info?: { uuid?: unknown; name?: unknown }; provider?: unknown }>).detail;
    if (!detail?.info || !provider(detail.provider) || typeof detail.info.uuid !== "string" || typeof detail.info.name !== "string") return;
    add({ id: detail.info.uuid.slice(0, 100), name: detail.info.name.slice(0, 80), provider: detail.provider, source: "eip6963" });
  };
  window.addEventListener("eip6963:announceProvider", announce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  const fallback = (window as Window & { ethereum?: unknown }).ethereum;
  if (provider(fallback)) add({ id: "injected-wallet", name: "Browser wallet", provider: fallback, source: "injected" });
  return () => window.removeEventListener("eip6963:announceProvider", announce);
}
export async function connectWallet(provider: Eip1193Provider): Promise<WalletSnapshot> {
  try {
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    if (!Array.isArray(accounts) || !isAddress(accounts[0])) throw new WalletError("The wallet did not expose an account.", "NO_ACCOUNT");
    return { address: accounts[0], chainId: parseChain(await provider.request({ method: "eth_chainId" })) };
  } catch (error) { throw walletError(error); }
}
export async function assertWallet(provider: Eip1193Provider, account: string, expectedChainId: number): Promise<void> {
  const [accounts, rawChain] = await Promise.all([provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" })]);
  if (!Array.isArray(accounts) || !sameAddress(accounts[0], account)) throw new WalletError("The active wallet account changed. Sign in with the current account before continuing.", "ACCOUNT_CHANGED");
  if (parseChain(rawChain) !== expectedChainId) throw new WalletError("Switch the wallet to the required network before continuing.", "WRONG_CHAIN");
}
export async function switchWalletChain(provider: Eip1193Provider, chainId: number): Promise<number> {
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex(chainId) }] });
    const current = parseChain(await provider.request({ method: "eth_chainId" }));
    if (current !== chainId) throw new WalletError("The wallet did not switch to the requested network.", "WRONG_CHAIN");
    return current;
  } catch (error) { throw walletError(error); }
}
export async function addWalletChain(provider: Eip1193Provider, chain: WalletChain): Promise<void> {
  parseChain(chain.chainId);
  if (!chain.rpcUrls.length || chain.nativeCurrency.decimals !== 18) throw new WalletError("The server did not provide a complete network configuration.", "INVALID_CHAIN");
  for (const raw of chain.rpcUrls) {
    const url = new URL(raw);
    if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new WalletError("The network configuration contains an unsupported RPC URL.", "INVALID_CHAIN");
  }
  try { await provider.request({ method: "wallet_addEthereumChain", params: [chain] }); }
  catch (error) { throw walletError(error); }
}
function signature(value: unknown): string {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(value) || value.length > 8194) throw new WalletError("The wallet returned an invalid signature.", "INVALID_SIGNATURE");
  return value;
}
export function assertSigninMessage(message: string, account: string, chainId: number, expiresAt: string): void {
  const lines = message.split("\n");
  const first = lines[0] || "";
  const suffix = " wants you to sign in with your Ethereum account:";
  const domain = first.endsWith(suffix) ? first.slice(0, -suffix.length) : "";
  const uri = lines.find(line => line.startsWith("URI: "))?.slice(5);
  let uriOrigin = "";
  try { uriOrigin = uri ? new URL(uri).origin : ""; } catch { /* rejected below */ }
  if ((domain !== window.location.host && domain !== window.location.origin) || uriOrigin !== window.location.origin || !sameAddress(lines[1], account) || !lines.includes(`Chain ID: ${chainId}`) || !lines.some(line => /^Nonce: [A-Za-z0-9]{8,}$/.test(line))) throw new WalletError("The sign-in message does not match this site, account, or network. It was not sent to your wallet.", "CHALLENGE_MISMATCH");
  const expires = Date.parse(expiresAt);
  const messageExpiry = lines.find(line => line.startsWith("Expiration Time: "))?.slice(17);
  if (!lines.includes("Version: 1") || !messageExpiry || Date.parse(messageExpiry) !== expires) throw new WalletError("The sign-in message expiry or version is inconsistent.", "CHALLENGE_MISMATCH");
  if (!Number.isFinite(expires) || expires <= Date.now()) throw new WalletError("The sign-in challenge expired. Request a new one.", "CHALLENGE_EXPIRED");
}
export async function signPersonalMessage(provider: Eip1193Provider, account: string, chainId: number, message: string): Promise<string> {
  try {
    await assertWallet(provider, account, chainId);
    const hexMessage = `0x${Array.from(new TextEncoder().encode(message), byte => byte.toString(16).padStart(2, "0")).join("")}`;
    return signature(await provider.request({ method: "personal_sign", params: [hexMessage, account] }));
  } catch (error) { throw walletError(error); }
}
// These narrow schemas are pinned to the HumanDock contract types; tests compare
// them with the repository's generated ABI and signing helpers.
const signingSchemas: Record<string, { domain: string; fields: string[] }> = {
  DeliveryEnvelope: { domain: "HumanDockReviewEscrow", fields: ["taskId:uint256", "taskCommitment:bytes32", "deliveryCommitment:bytes32", "reviewer:address", "verdict:uint8", "schemaHash:bytes32", "issuedAt:uint64", "expiresAt:uint64", "nonce:uint256"] },
  ApprovalIntent: { domain: "HumanDockReleaseRegistry", fields: ["escrow:address", "taskId:uint256", "brandAuthority:address", "deliveryCommitment:bytes32", "purposeHash:bytes32", "expiresAt:uint64", "nonce:uint256"] },
  RevocationIntent: { domain: "HumanDockReleaseRegistry", fields: ["approvalId:bytes32", "brandAuthority:address", "expiresAt:uint64", "nonce:uint256"] },
};
export const actionSelectors: Record<string, string[]> = {
  fund: ["0x06f7a461"], "accept-assignment": ["0x5d27d3c7"], reviews: ["0x99c35a71"], "accept-service": ["0xc01d8225"],
  approvals: ["0x5dd8817e"], revoke: ["0xb10107d4"], cancel: ["0xd64a6453"], disputes: ["0xf3eca9f5"],
  timeouts: ["0xdb598c6b", "0xdc79d959", "0xc384c781", "0xa169dc55"], withdraw: ["0x72b0d90c"],
};
export function assertTypedData(data: TypedData, account: string, chainId: number, allowedTargets: string[], primaryType?: string): void {
  if (!data || typeof data !== "object" || !data.domain || !data.message || !data.types || !Array.isArray(data.types[data.primaryType]) || (primaryType && data.primaryType !== primaryType)) throw new WalletError("The signing request has an unexpected schema.", "INVALID_TYPED_DATA");
  const schema = signingSchemas[data.primaryType];
  if (!schema || data.domain.name !== schema.domain || data.domain.version !== "1" || JSON.stringify(data.types[data.primaryType].map(field => `${field.name}:${field.type}`)) !== JSON.stringify(schema.fields) || Object.keys(data.types).some(key => key !== data.primaryType && key !== "EIP712Domain") || Object.keys(data.domain).some(key => !["name", "version", "chainId", "verifyingContract"].includes(key))) throw new WalletError("The signing schema does not match the deployed HumanDock protocol.", "INVALID_TYPED_DATA");
  const domainFields = ["name:string", "version:string", "chainId:uint256", "verifyingContract:address"];
  if (data.types.EIP712Domain && JSON.stringify(data.types.EIP712Domain.map(field => `${field.name}:${field.type}`)) !== JSON.stringify(domainFields)) throw new WalletError("The EIP-712 domain schema is unexpected.", "INVALID_TYPED_DATA");
  const expectedFields = schema.fields.map(field => field.split(":"));
  if (Object.keys(data.message).length !== expectedFields.length || expectedFields.some(([name, type]) => {
    const value = data.message[name];
    if (type === "address") return !isAddress(value);
    if (type === "bytes32") return typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value);
    if (!/^[0-9]+$/.test(String(value))) return true;
    return BigInt(String(value)) >= 2n ** BigInt(type.slice(4));
  })) throw new WalletError("The signing values are incomplete or contain unexpected fields.", "INVALID_TYPED_DATA");
  let requestedChain: bigint;
  try { requestedChain = BigInt(data.domain.chainId as string | number); } catch { throw new WalletError("The signing domain has no valid chain ID.", "INVALID_TYPED_DATA"); }
  if (requestedChain !== BigInt(chainId) || !isAddress(data.domain.verifyingContract) || !allowedTargets.some(target => sameAddress(target, String(data.domain.verifyingContract)))) throw new WalletError("The signing request is for a different network or contract.", "SIGNING_DOMAIN_MISMATCH");
  const signer = data.message.brandAuthority ?? data.message.reviewer;
  if (signer && !sameAddress(String(signer), account)) throw new WalletError("The signing request names a different account.", "ACCOUNT_CHANGED");
}
export async function signTypedMessage(provider: Eip1193Provider, account: string, chainId: number, data: TypedData): Promise<string> {
  try {
    await assertWallet(provider, account, chainId);
    const domainType = [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }];
    const encoded = JSON.stringify({ ...data, types: { EIP712Domain: domainType, ...data.types } }, (_key, value) => typeof value === "bigint" ? value.toString() : value);
    return signature(await provider.request({ method: "eth_signTypedData_v4", params: [account, encoded] }));
  } catch (error) { throw walletError(error); }
}
export function assertTransaction(tx: WalletTransaction, expected: { account: string; chainId: number; allowedTargets: string[]; amountWei: string; action?: string; receiver?: string }): void {
  if (!tx || !sameAddress(tx.from, expected.account) || tx.chainId !== expected.chainId) throw new WalletError("The transaction account or network differs from this session.", "TRANSACTION_MISMATCH");
  if (!isAddress(tx.to) || !expected.allowedTargets.some(target => sameAddress(target, tx.to))) throw new WalletError("The transaction target is not an approved HumanDock contract.", "TRANSACTION_TARGET_MISMATCH");
  if (expected.action && !actionSelectors[expected.action]?.includes(tx.data.slice(0, 10).toLowerCase())) throw new WalletError("The contract call does not match the requested HumanDock action.", "TRANSACTION_ACTION_MISMATCH");
  if (expected.action === "withdraw" && (!expected.receiver || tx.data.length !== 74 || !/^0{24}$/.test(tx.data.slice(10, 34)) || !sameAddress(`0x${tx.data.slice(-40)}`, expected.receiver))) throw new WalletError("The withdrawal receiver differs from the signed-in wallet.", "WITHDRAWAL_RECEIVER_MISMATCH");
  if (!/^0x[0-9a-f]{8}(?:[0-9a-f]{2})*$/i.test(tx.data) || !/^0x[0-9a-f]+$/i.test(tx.value) || !/^\d+$/.test(expected.amountWei) || BigInt(tx.value) !== BigInt(expected.amountWei)) throw new WalletError("The transaction data or payment amount does not match the prepared request.", "TRANSACTION_VALUE_MISMATCH");
}
export async function sendWalletTransaction(provider: Eip1193Provider, tx: WalletTransaction): Promise<string> {
  try {
    await assertWallet(provider, tx.from, tx.chainId);
    const hash = await provider.request({ method: "eth_sendTransaction", params: [{ from: tx.from, to: tx.to, data: tx.data, value: tx.value, chainId: chainHex(tx.chainId) }] });
    if (typeof hash !== "string" || !/^0x[0-9a-f]{64}$/i.test(hash)) throw new WalletError("The wallet did not return a valid transaction hash. Check the wallet before trying again; do not assume nothing was broadcast.", "BROADCAST_UNKNOWN");
    return hash;
  } catch (error) { throw walletError(error); }
}
