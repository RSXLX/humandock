import assert from "node:assert/strict";
import { test } from "node:test";
import { toFunctionSelector } from "viem";
import { releaseRegistryAbi, reviewEscrowAbi } from "../../../packages/me/src/generated-abis";
import { approvalTypedData, deliveryTypedData, revocationTypedData } from "../../../packages/me/src/contracts";
import { actionSelectors, assertSigninMessage, assertTransaction, assertTypedData, parseChain, sendWalletTransaction, signTypedMessage, type Eip1193Provider, type TypedData, type WalletTransaction } from "./wallet";

const actor = "0x1111111111111111111111111111111111111111";
const escrow = "0x2222222222222222222222222222222222222222";
const registry = "0x3333333333333333333333333333333333333333";
const hash = `0x${"44".repeat(32)}` as const;
const asWire = (value: unknown): TypedData => JSON.parse(JSON.stringify(value, (_key, field) => typeof field === "bigint" ? field.toString() : field));
const approval = () => asWire(approvalTypedData(31337, registry, { escrow, taskId: 1n, brandAuthority: actor, deliveryCommitment: hash, purposeHash: hash, expiresAt: 9999999999n, nonce: 1n }));
const tx: WalletTransaction = { from: actor, to: escrow, data: `0x72b0d90c${actor.slice(2).padStart(64, "0")}`, value: "0x0", chainId: 31337 };

// Pins the browser's allowed method list to the actual deployed contract ABI.
test("wallet action allowlist matches HumanDock contract functions, excluding administration", () => {
  const methods: Record<string, string[]> = { fund: ["createAndFund"], "accept-assignment": ["acceptAssignment"], reviews: ["submitDelivery"], "accept-service": ["acceptService"], approvals: ["approve"], revoke: ["revoke"], cancel: ["cancelUnassigned"], disputes: ["openDispute"], timeouts: ["expireUnassigned", "expireUndelivered", "settleAfterWindow", "finalizeDisputeTimeout"], withdraw: ["withdrawTo"] };
  const abi = [...reviewEscrowAbi, ...releaseRegistryAbi];
  for (const [action, names] of Object.entries(methods)) {
    const expected = names.map(name => { const method = abi.find(item => item.type === "function" && item.name === name); assert.ok(method && method.type === "function"); return toFunctionSelector(method); });
    assert.deepEqual(actionSelectors[action], expected);
  }
});

test("browser accepts the repository's delivery, approval and revocation typed data", () => {
  const delivery = asWire(deliveryTypedData(31337, escrow, { taskId: 1n, taskCommitment: hash, deliveryCommitment: hash, reviewer: actor, verdict: 1, schemaHash: hash, issuedAt: 1n, expiresAt: 9999999999n, nonce: 1n }));
  const revocation = asWire(revocationTypedData(31337, registry, { approvalId: hash, brandAuthority: actor, expiresAt: 9999999999n, nonce: 1n }));
  assert.doesNotThrow(() => assertTypedData(delivery, actor, 31337, [escrow], "DeliveryEnvelope"));
  assert.doesNotThrow(() => assertTypedData(approval(), actor, 31337, [registry], "ApprovalIntent"));
  assert.doesNotThrow(() => assertTypedData(revocation, actor, 31337, [registry], "RevocationIntent"));
});

test("typed data rejects wrong chain, signer, contract, domain and hidden plaintext", () => {
  assert.throws(() => assertTypedData(approval(), actor, 1, [registry], "ApprovalIntent"), /network or contract/);
  assert.throws(() => assertTypedData(approval(), escrow, 31337, [registry], "ApprovalIntent"), /different account/);
  assert.throws(() => assertTypedData(approval(), actor, 31337, [escrow], "ApprovalIntent"), /network or contract/);
  const domain = approval(); domain.domain.name = "UnrelatedApproval";
  assert.throws(() => assertTypedData(domain, actor, 31337, [registry]), /protocol/);
  const plaintext = approval(); plaintext.message.originalCopy = "Private ad copy";
  assert.throws(() => assertTypedData(plaintext, actor, 31337, [registry]), /unexpected fields/);
  const changedSchema = approval(); changedSchema.types.ApprovalIntent.push({ name: "originalCopy", type: "string" });
  assert.throws(() => assertTypedData(changedSchema, actor, 31337, [registry]), /protocol/);
});

test("wallet transaction validation rejects another action, receiver and call value", () => {
  const expected = { account: actor, chainId: 31337, allowedTargets: [escrow], amountWei: "0", action: "withdraw", receiver: actor };
  assert.doesNotThrow(() => assertTransaction(tx, expected));
  assert.throws(() => assertTransaction({ ...tx, value: "0x1" }, expected), /payment amount/);
  assert.throws(() => assertTransaction(tx, { ...expected, action: "accept-service" }), /requested HumanDock action/);
  assert.throws(() => assertTransaction(tx, { ...expected, receiver: registry }), /receiver/);
  assert.throws(() => assertTransaction({ ...tx, to: registry }, expected), /approved HumanDock contract/);
});

test("wrong wallet account or network is rejected before sending a transaction", async () => {
  const calls: string[] = [];
  let chain = "0x1", address = actor;
  const provider: Eip1193Provider = { async request({ method }) { calls.push(method); if (method === "eth_accounts") return [address]; if (method === "eth_chainId") return chain; throw new Error("A send must not occur"); } };
  await assert.rejects(sendWalletTransaction(provider, tx), /required network/);
  chain = "0x7a69"; address = registry;
  await assert.rejects(sendWalletTransaction(provider, tx), /active wallet account changed/);
  assert.equal(calls.includes("eth_sendTransaction"), false);
});

test("EIP-712 v4 includes the domain schema expected by EVM wallets", async () => {
  let signed: TypedData | undefined;
  const provider: Eip1193Provider = { async request({ method, params }) { if (method === "eth_accounts") return [actor]; if (method === "eth_chainId") return "0x7a69"; if (method === "eth_signTypedData_v4") { signed = JSON.parse(String((params as unknown[])[1])); return `0x${"11".repeat(65)}`; } throw new Error("Unexpected method"); } };
  await signTypedMessage(provider, actor, 31337, approval());
  assert.equal(signed?.types.EIP712Domain.length, 4);
  assert.equal(signed?.message.deliveryCommitment, hash);
});

test("invalid wallet broadcast results are treated as unknown, never a success", async () => {
  const provider: Eip1193Provider = { async request({ method }) { if (method === "eth_accounts") return [actor]; if (method === "eth_chainId") return "0x7a69"; return null; } };
  await assert.rejects(sendWalletTransaction(provider, tx), (error: unknown) => (error as { code: string }).code === "BROADCAST_UNKNOWN");
  assert.throws(() => parseChain("31337"), /invalid network ID/);
});

test("SIWE preview rejects another origin and inconsistent expiry", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" } } });
  try {
    const expires = new Date(Date.now() + 300000).toISOString();
    const message = `127.0.0.1:3000 wants you to sign in with your Ethereum account:\n${actor}\n\nSign in to HumanDock.\n\nURI: http://127.0.0.1:3000\nVersion: 1\nChain ID: 31337\nNonce: 12345678abcdef\nIssued At: ${new Date().toISOString()}\nExpiration Time: ${expires}`;
    assert.doesNotThrow(() => assertSigninMessage(message, actor, 31337, expires));
    assert.throws(() => assertSigninMessage(message.replaceAll("127.0.0.1:3000", "evil.example"), actor, 31337, expires), /does not match/);
    assert.throws(() => assertSigninMessage(message, actor, 31337, new Date(Date.now() + 600000).toISOString()), /inconsistent/);
  } finally { if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window"); }
});
