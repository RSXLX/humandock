"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import type { IntentRequest, MeConfig, Session, Task, TransactionIntent } from "@/lib/types";
import { assertTransaction, assertTypedData, assertWallet, sameAddress, sendWalletTransaction, signTypedMessage, walletError, WalletError } from "@/lib/wallet";
import type { WalletController } from "./useWallet";

type Props = {
  session: Session | null; config: MeConfig | null; wallet: WalletController;
  post: <T>(path: string, body: unknown) => Promise<T>;
  onTask: (task: Task) => void; onRefresh: () => Promise<void>;
};
type Recovery = { account: string; chainId: number; intentId: string; hash?: string; unknown?: boolean };
const unfinished = (intent: TransactionIntent) => !["reverted", "expired", "rejected", "replaced"].includes(intent.status) && !(intent.status === "confirmed" && intent.applied);
const waitingReceipt = (intent: TransactionIntent) => Boolean(intent.txHash) && unfinished(intent);
const storageKey = (account: string, chainId: number) => `humandock:tx-recovery:v1:${chainId}:${account.toLowerCase()}`;
function savedRecovery(account: string, chainId: number): Recovery[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(storageKey(account, chainId)) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is Recovery => item && sameAddress(item.account, account) && item.chainId === chainId && typeof item.intentId === "string" && (item.unknown === true || /^0x[0-9a-f]{64}$/i.test(item.hash || ""))) : [];
  } catch { return []; }
}
function saveRecovery(item: Recovery) {
  try { const items = savedRecovery(item.account, item.chainId).filter(old => old.intentId !== item.intentId); sessionStorage.setItem(storageKey(item.account, item.chainId), JSON.stringify([...items, item].slice(-50))); return true; } catch { return false; }
}
function clearRecovery(intent: TransactionIntent) {
  try { sessionStorage.setItem(storageKey(intent.account, intent.chainId), JSON.stringify(savedRecovery(intent.account, intent.chainId).filter(item => item.intentId !== intent.id))); } catch { /* optional browser storage */ }
}

export function useLiveTransactions(props: Props) {
  const [active, setActive] = useState<TransactionIntent | null>(null);
  const [visible, setVisible] = useState(false);
  const [recent, setRecent] = useState<TransactionIntent[]>([]);
  const [busy, setBusy] = useState<"prepare" | "sign" | "send" | "register" | "reconcile" | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [errorCode, setErrorCode] = useState<string | number>("");
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [recentError, setRecentError] = useState("");
  const propsRef = useRef(props); propsRef.current = props;
  const activeRef = useRef(active); activeRef.current = active;
  const recentRef = useRef(recent); recentRef.current = recent;
  const operation = useRef(false);
  const generation = useRef(0);
  const sessionId = props.session?.mode === "me" ? props.session.user?.id : undefined;
  const account = props.session?.user?.wallet;
  const chainId = props.config?.network?.chainId;

  const loadRecent = useCallback(async () => {
    const { session } = propsRef.current;
    if (session?.mode !== "me" || !session.user) return;
    const userId = session.user.id, epoch = generation.current;
    try {
      const result = await api<{ intents: TransactionIntent[] }>("/me/intents");
      if (epoch === generation.current && propsRef.current.session?.user?.id === userId) { setRecent(result.intents); setRecentError(""); }
    } catch (err) { if (epoch === generation.current && propsRef.current.session?.user?.id === userId) setRecentError(errorMessage(err)); }
  }, []);

  useEffect(() => {
    generation.current += 1; operation.current = false;
    setActive(null); setVisible(false); setRecent([]); setBusy(null); setChecking(false); setError(""); setErrorCode(""); setRecovery(null); setRecentError("");
    if (sessionId) void loadRecent();
  }, [sessionId, account, chainId, loadRecent]);

  function remember(intent: TransactionIntent) {
    if (!sameAddress(intent.account, propsRef.current.session?.user?.wallet)) return;
    setActive(intent);
    setRecent(items => [intent, ...items.filter(item => item.id !== intent.id)].slice(0, 50));
    const saved = savedRecovery(intent.account, intent.chainId).find(item => item.intentId === intent.id) || null;
    const registeredSavedHash = Boolean(saved?.hash && intent.txHash && saved.hash.toLowerCase() === intent.txHash.toLowerCase());
    const resolvedOnChain = intent.status === "confirmed" && intent.applied;
    // A failed replacement registration can leave the server on the old hash.
    // Preserve that newer browser hash (and unknown sends) until acknowledged or resolved.
    if (registeredSavedHash || resolvedOnChain) { clearRecovery(intent); setRecovery(null); }
    else setRecovery(saved);
  }
  function verifyContext(intent: TransactionIntent) {
    const { session, config, wallet } = propsRef.current;
    if (!session?.user || session.mode !== "me" || !sameAddress(session.user.wallet, intent.account)) throw new WalletError("Sign in with the account that prepared this transaction.", "ACCOUNT_CHANGED");
    if (!config?.network || !config.contracts || !config.writesEnabled) throw new WalletError(config?.reasons.join(" · ") || "Network and deployment checks must pass before signing or sending.", "NETWORK_NOT_READY");
    if (["fund", "accept-assignment"].includes(intent.action) && !config.admissionsEnabled) throw new WalletError(config.admissionReasons.join(" · ") || "New review work is paused until identity admission checks pass.", "ADMISSION_NOT_READY");
    if (intent.chainId !== config.network.chainId || !intent.allowedTargets.length || !intent.allowedTargets.every(target => [config.contracts!.escrow, config.contracts!.registry].some(address => sameAddress(address, target)))) throw new WalletError("This request no longer matches the configured network and contracts. Prepare a new request.", "DEPLOYMENT_CHANGED");
    if (Date.parse(intent.expiresAt) <= Date.now() || !Number.isFinite(Date.parse(intent.expiresAt))) throw new WalletError("This signing request expired. Refresh it before continuing.", "INTENT_EXPIRED");
    if (!wallet.selected || !wallet.snapshot || !sameAddress(wallet.snapshot.address, intent.account)) throw new WalletError("Connect the signed-in wallet account before continuing.", "WALLET_REQUIRED");
    if (wallet.snapshot.chainId !== intent.chainId) throw new WalletError("Switch networks in the wallet panel before continuing.", "WRONG_CHAIN");
    const target = ["approvals", "revoke"].includes(intent.action) ? config.contracts.registry : config.contracts.escrow;
    return { provider: wallet.selected.provider, target };
  }
  function currentAttempt(epoch: number, userId: string | undefined) { return epoch === generation.current && userId === propsRef.current.session?.user?.id; }
  function fail(err: unknown) { const normalized = err instanceof WalletError ? err : walletError(err); setError(errorMessage(err)); setErrorCode(normalized.code); }

  async function prepare(request: IntentRequest) {
    if (operation.current) throw new Error("Finish the current transaction request first.");
    const sameTask = recentRef.current.filter(item => (item.taskId || null) === (request.taskId || null));
    const existing = sameTask.find(item => savedRecovery(item.account, item.chainId).some(saved => saved.intentId === item.id))
      || sameTask.find(item => item.action === request.action && unfinished(item));
    if (existing) { remember(existing); setVisible(true); setError("A saved or unfinished wallet request exists for this task. Review its recovery record before preparing another transaction."); return; }
    const epoch = generation.current, userId = propsRef.current.session?.user?.id;
    operation.current = true; setBusy("prepare"); setError(""); setErrorCode("");
    try {
      const result = await propsRef.current.post<{ intent: TransactionIntent }>("/me/intents", request);
      if (currentAttempt(epoch, userId)) { remember(result.intent); setVisible(true); }
    } catch (err) { if (currentAttempt(epoch, userId)) fail(err); throw err; }
    finally { if (currentAttempt(epoch, userId)) { operation.current = false; setBusy(null); } }
  }
  function resume(intent: TransactionIntent) { if (operation.current) return; remember(intent); setVisible(true); setError(""); setErrorCode(""); }

  async function sign() {
    const intent = activeRef.current;
    if (!intent || operation.current || intent.status !== "awaiting_signature" || !intent.typedData) return;
    const epoch = generation.current, userId = propsRef.current.session?.user?.id;
    operation.current = true; setBusy("sign"); setError(""); setErrorCode("");
    try {
      const { provider, target } = verifyContext(intent);
      const primaryType = { reviews: "DeliveryEnvelope", approvals: "ApprovalIntent", revoke: "RevocationIntent" }[intent.action as "reviews" | "approvals" | "revoke"];
      if (!primaryType) throw new WalletError("This action should not ask for a typed signature. Refresh the request.", "UNEXPECTED_SIGNATURE");
      assertTypedData(intent.typedData, intent.account, intent.chainId, [target], primaryType);
      if (intent.summary.deliveryCommitment && intent.action !== "revoke" && String(intent.typedData.message.deliveryCommitment).toLowerCase() !== intent.summary.deliveryCommitment.toLowerCase()) throw new WalletError("The signing commitment differs from the displayed reviewed content.", "COMMITMENT_MISMATCH");
      if (intent.action === "approvals" && !sameAddress(String(intent.typedData.message.escrow), propsRef.current.config?.contracts?.escrow)) throw new WalletError("The approval names a different review escrow.", "DEPLOYMENT_CHANGED");
      const signature = await signTypedMessage(provider, intent.account, intent.chainId, intent.typedData);
      if (!currentAttempt(epoch, userId)) return;
      await assertWallet(provider, intent.account, intent.chainId);
      const result = await propsRef.current.post<{ intent: TransactionIntent }>(`/me/intents/${encodeURIComponent(intent.id)}/signature`, { signature });
      if (currentAttempt(epoch, userId)) remember(result.intent);
    } catch (err) { if (currentAttempt(epoch, userId)) fail(err); }
    finally { if (currentAttempt(epoch, userId)) { operation.current = false; setBusy(null); } }
  }

  async function register(intent: TransactionIntent, txHash: string, epoch: number, userId: string | undefined) {
    const result = await propsRef.current.post<{ intent: TransactionIntent }>(`/me/intents/${encodeURIComponent(intent.id)}/broadcast`, { txHash });
    if (currentAttempt(epoch, userId)) remember(result.intent);
  }
  async function send() {
    const intent = activeRef.current;
    if (!intent || operation.current || intent.status !== "ready" || !intent.transaction || intent.txHash || recovery) return;
    const epoch = generation.current, userId = propsRef.current.session?.user?.id;
    operation.current = true; setBusy("send"); setError(""); setErrorCode("");
    let submittedToWallet = false, hash: string | undefined;
    try {
      const { provider, target } = verifyContext(intent);
      assertTransaction(intent.transaction, { account: intent.account, chainId: intent.chainId, allowedTargets: [target], amountWei: intent.summary.amountWei, action: intent.action, receiver: intent.account });
      if (intent.action !== "fund" && BigInt(intent.transaction.value) !== 0n) throw new WalletError("This action must not include a native currency payment.", "UNEXPECTED_PAYMENT");
      await assertWallet(provider, intent.account, intent.chainId);
      const pendingRecovery = { account: intent.account, chainId: intent.chainId, intentId: intent.id, unknown: true };
      if (!saveRecovery(pendingRecovery)) throw new WalletError("This browser cannot preserve transaction recovery data. Enable session storage before sending; no wallet request was made.", "RECOVERY_STORAGE_UNAVAILABLE");
      setRecovery(pendingRecovery);
      submittedToWallet = true;
      hash = await sendWalletTransaction(provider, intent.transaction);
      const saved = { account: intent.account, chainId: intent.chainId, intentId: intent.id, hash };
      saveRecovery(saved);
      if (!currentAttempt(epoch, userId)) return;
      setRecovery(saved); setBusy("register");
      await register(intent, hash, epoch, userId);
    } catch (err) {
      const code = walletError(err).code;
      if (submittedToWallet && !hash && code === 4001) { clearRecovery(intent); if (currentAttempt(epoch, userId)) setRecovery(null); }
      if (submittedToWallet && !hash && code !== 4001) {
        const saved = { account: intent.account, chainId: intent.chainId, intentId: intent.id, unknown: true };
        saveRecovery(saved); if (currentAttempt(epoch, userId)) setRecovery(saved);
      }
      if (currentAttempt(epoch, userId)) fail(err);
    } finally { if (currentAttempt(epoch, userId)) { operation.current = false; setBusy(null); } }
  }
  async function registerHash(hash: string) {
    const intent = activeRef.current;
    if (!intent || operation.current) return;
    if (!/^0x[0-9a-f]{64}$/i.test(hash)) { setError("Enter the full transaction hash from your wallet (0x followed by 64 hexadecimal characters)."); return; }
    const epoch = generation.current, userId = propsRef.current.session?.user?.id;
    operation.current = true; setBusy("register"); setError("");
    const saved = { account: intent.account, chainId: intent.chainId, intentId: intent.id, hash };
    saveRecovery(saved); setRecovery(saved);
    try { await register(intent, hash, epoch, userId); }
    catch (err) { if (currentAttempt(epoch, userId)) fail(err); }
    finally { if (currentAttempt(epoch, userId)) { operation.current = false; setBusy(null); } }
  }
  const reconcile = useCallback(async (quiet = false) => {
    const intent = activeRef.current;
    if (!intent || operation.current || propsRef.current.session?.mode !== "me") return;
    const epoch = generation.current, userId = propsRef.current.session?.user?.id;
    operation.current = true; setChecking(true); if (!quiet) { setBusy("reconcile"); setError(""); }
    try {
      const result = await propsRef.current.post<{ intent: TransactionIntent; task?: Task }>(`/me/intents/${encodeURIComponent(intent.id)}/reconcile`, {});
      if (!currentAttempt(epoch, userId)) return;
      remember(result.intent);
      if (result.task) propsRef.current.onTask(result.task);
      if (result.intent.applied || ["reorged", "reverted", "rejected", "replaced"].includes(result.intent.status)) await propsRef.current.onRefresh();
      setError(""); setErrorCode("");
    } catch (err) { if (currentAttempt(epoch, userId)) fail(err); }
    finally { if (currentAttempt(epoch, userId)) { operation.current = false; setBusy(null); setChecking(false); } }
  }, []);
  useEffect(() => {
    if (!active || !waitingReceipt(active)) return;
    const timer = window.setInterval(() => void reconcile(true), 5000);
    return () => window.clearInterval(timer);
  }, [active, reconcile]);

  return { active, visible, recent, busy, checking, error, errorCode, recovery, recentError, prepare, resume, sign, send, registerHash, reconcile, loadRecent, close: () => { if (!busy) setVisible(false); }, reopen: () => setVisible(true), unfinished: recent.filter(unfinished).length };
}
export type TransactionController = ReturnType<typeof useLiveTransactions>;
