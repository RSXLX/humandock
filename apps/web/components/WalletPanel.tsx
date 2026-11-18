"use client";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage, mutationOptions } from "@/lib/api";
import type { MeConfig, Session } from "@/lib/types";
import { assertSigninMessage, assertWallet, sameAddress, signPersonalMessage, walletError } from "@/lib/wallet";
import type { WalletController } from "@/hooks/useWallet";
import { formatDate } from "@/lib/format";
import Modal from "./Modal";
import Icon from "./Icon";

type Challenge = { challengeId: string; message: string; expiresAt: string };
type Props = {
  config: MeConfig | null; configError: string; configLoading: boolean; wallet: WalletController; session: Session | null;
  identityBusy: boolean; sessionBusy?: boolean; onClose: () => void; onRefreshConfig: () => Promise<void>;
  onAuthenticated: (session: Session) => void; onRefreshIdentity: () => Promise<void>;
};
export default function WalletPanel({ config, configError, configLoading, wallet, session, identityBusy, sessionBusy = false, onClose, onRefreshConfig, onAuthenticated, onRefreshIdentity }: Props) {
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [phase, setPhase] = useState<"challenge" | "signature" | null>(null);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const currentAccount = useRef(wallet.snapshot?.address); currentAccount.current = wallet.snapshot?.address;
  const busy = Boolean(phase || wallet.busy || identityBusy || sessionBusy);
  const network = config?.network;
  const sameNetwork = Boolean(network && wallet.snapshot?.chainId === network.chainId);
  const signedIn = Boolean(session?.user && sameAddress(session.user.wallet, wallet.snapshot?.address));
  useEffect(() => { epoch.current += 1; setChallenge(null); setPhase(null); setError(""); }, [wallet.snapshot?.address, wallet.snapshot?.chainId]);
  useEffect(() => () => { epoch.current += 1; }, []);

  async function prepareSignIn() {
    if (!wallet.selected || !wallet.snapshot || !network || !sameNetwork || busy) return;
    const attempt = epoch.current;
    setPhase("challenge"); setError(""); setChallenge(null);
    try {
      await assertWallet(wallet.selected.provider, wallet.snapshot.address, network.chainId);
      const result = await api<Challenge>("/auth/challenge", { method: "POST", body: JSON.stringify({ address: wallet.snapshot.address, chainId: network.chainId }) });
      assertSigninMessage(result.message, wallet.snapshot.address, network.chainId, result.expiresAt);
      if (attempt === epoch.current) setChallenge(result);
    } catch (err) { if (attempt === epoch.current) setError(errorMessage(err)); }
    finally { if (attempt === epoch.current) setPhase(null); }
  }
  async function signIn() {
    if (!challenge || !wallet.selected || !wallet.snapshot || !network || busy) return;
    const attempt = epoch.current, address = wallet.snapshot.address;
    setPhase("signature"); setError("");
    try {
      assertSigninMessage(challenge.message, address, network.chainId, challenge.expiresAt);
      const signature = await signPersonalMessage(wallet.selected.provider, address, network.chainId, challenge.message);
      if (attempt !== epoch.current || !sameAddress(currentAccount.current, address)) return;
      await assertWallet(wallet.selected.provider, address, network.chainId);
      const result = await api<Session>("/auth/verify", { method: "POST", body: JSON.stringify({ challengeId: challenge.challengeId, signature }) });
      if (attempt === epoch.current && sameAddress(currentAccount.current, address) && sameAddress(result.user?.wallet, address)) { setChallenge(null); onAuthenticated(result); }
      else if (result.csrfToken) await api("/logout", mutationOptions(result.csrfToken, {}, crypto.randomUUID())).catch(() => undefined);
    } catch (err) { if (attempt === epoch.current) { setError(walletError(err).message); if (walletError(err).code !== 4001) setChallenge(null); } }
    finally { if (attempt === epoch.current) setPhase(null); }
  }

  return <Modal title="Connect your workspace wallet." subtitle="账户控制、ME 身份状态与审核技能分别验证。" onClose={onClose} busy={busy} footer={<><p>{sessionBusy ? "Clearing the previous application session…" : "Connecting does not sign in, prove expertise, or send a transaction."}</p><button className="btn" disabled={busy || configLoading} onClick={() => void onRefreshConfig()}>{configLoading ? <span className="spinner"/> : <Icon name="refresh" size={13}/>}Refresh network checks</button></>}>
    <div className={`form-notice ${config?.localTest ? "local-test-notice" : ""}`}><strong>{config?.localTest ? "LOCAL CHAIN TEST · NOT ME NETWORK" : network?.kind === "me-testnet" ? "ME TESTNET · TEST FUNDS" : network?.kind === "me-mainnet" ? "ME MAINNET · REAL FUNDS" : "ME connection not configured"}</strong><br/>{config?.localTest ? "Wallet signatures and contract transactions use a local test chain. Local test identity does not establish a real ME identity." : network ? `Transactions use ${network.chainName}. Read the exact action and amount before each wallet request.` : "Configure and verify the network and contract deployment before using wallet transactions."}</div>
    {configError && <div className="toast error" role="alert"><Icon name="alert" size={15}/><div>{configError}</div></div>}
    {!config?.writesEnabled && config?.reasons.length ? <div className="subtle-callout"><strong>Writes paused.</strong> {config.reasons.join(" · ")}</div> : null}
    {!config?.admissionsEnabled && config?.admissionReasons.length ? <div className="subtle-callout"><strong>New work paused.</strong> {config.admissionReasons.join(" · ")} Existing eligible refunds and withdrawals do not require a fresh identity check.</div> : null}
    <section className="wallet-step"><div className="form-section-title">01 / Connect an account</div>
      {wallet.choices.length ? <div className="wallet-choices">{wallet.choices.map(choice => <button className={`wallet-choice ${wallet.selected?.id === choice.id ? "selected" : ""}`} key={choice.id} disabled={busy} onClick={() => void wallet.connect(choice)}><Icon name="wallet" size={18}/><span><strong>{choice.name}</strong><small>{wallet.selected?.id === choice.id && wallet.snapshot ? "Connected in this tab" : "Connect this wallet"}</small></span>{wallet.busy === "connect" ? <span className="spinner"/> : <Icon name="arrow" size={14}/>}</button>)}</div> : <div className="subtle-callout">No compatible EVM wallet was detected. Open this page in a browser with an EIP-1193 wallet extension or an EVM wallet’s browser, then reload. HumanDock never asks for a seed phrase.</div>}
      {wallet.snapshot && <div className="wallet-account"><span className="field-label">Connected account</span><code>{wallet.snapshot.address}</code><span className="tiny muted">Wallet chain ID: {wallet.snapshot.chainId}</span></div>}
    </section>
    <section className="wallet-step"><div className="form-section-title">02 / Check the network</div>
      <dl className="definition-list"><div><dt>Required network</dt><dd>{network ? `${network.chainName} · ${network.chainId}` : "Not configured"}</dd></div><div><dt>Connection</dt><dd>{!wallet.snapshot ? "Connect a wallet first" : sameNetwork ? "Correct network" : "Wrong network · writes disabled"}</dd></div><div><dt>Deployment checks</dt><dd>{config?.status || "Unavailable"}</dd></div><div><dt>Finality policy</dt><dd>{config ? `${config.confirmations} confirmation${config.confirmations === 1 ? "" : "s"}` : "Unavailable"}</dd></div></dl>
      {wallet.snapshot && network && !sameNetwork && <div className="button-row" style={{ marginTop: 12 }}><button className="btn navy" disabled={busy} onClick={() => void wallet.switchNetwork(network.chainId)}>{wallet.busy === "switch" ? <span className="spinner"/> : <Icon name="globe" size={13}/>}Switch to {network.chainName}</button>{wallet.missingNetwork && config?.walletChain && <button className="btn" disabled={busy} onClick={() => void wallet.addNetwork(config.walletChain!)}>{wallet.busy === "add" ? <span className="spinner"/> : <Icon name="plus" size={13}/>}Add configured network</button>}</div>}
      {config?.walletChain && wallet.missingNetwork && <details className="transaction-details"><summary>Review the network before adding it</summary><pre>{JSON.stringify(config.walletChain, null, 2)}</pre></details>}
    </section>
    <section className="wallet-step"><div className="form-section-title">03 / Sign in, then check identity</div>
      {signedIn ? <><div className="identity-result"><Icon name="check" size={17}/><div><strong>Wallet account signed in</strong><p>{session?.user?.name} · {session?.user?.role} role assigned by the server</p></div></div><dl className="definition-list"><div><dt>Identity status</dt><dd><span className={`badge ${session?.user?.identity.status === "verified" ? "green" : "amber"}`}>{session?.user?.identity.status?.replaceAll("_", " ")}</span></dd></div><div><dt>Identity result</dt><dd>{session?.user?.identity.label}</dd></div>{session?.user?.identity.checkedAt && <div><dt>Last checked</dt><dd>{formatDate(session.user.identity.checkedAt, true)}</dd></div>}<div><dt>Review expertise</dt><dd>Separately curated; ME ID does not certify English or advertising expertise.</dd></div></dl><button className="btn" style={{ marginTop: 12 }} disabled={busy} onClick={() => void onRefreshIdentity()}>{identityBusy ? <span className="spinner"/> : <Icon name="shield" size={13}/>}Refresh identity status</button></> : <><p className="field-help">Review a one-use sign-in message for this site. Its signature authorizes your application session, with no payment or contract approval.</p>{challenge ? <><pre className="signin-message">{challenge.message}</pre><div className="button-row"><button className="btn primary" disabled={busy || !sameNetwork} onClick={() => void signIn()}>{phase === "signature" ? <span className="spinner"/> : <Icon name="lock" size={13}/>}Sign in with wallet</button><button className="btn" disabled={busy} onClick={() => void prepareSignIn()}>New sign-in message</button></div></> : <button className="btn navy" style={{ marginTop: 12 }} disabled={busy || !wallet.snapshot || !sameNetwork} onClick={() => void prepareSignIn()}>{phase === "challenge" ? <span className="spinner"/> : <Icon name="file" size={13}/>}Review sign-in message</button>}</>}
    </section>
    {(wallet.error || error) && <div className="toast error" role="alert"><Icon name="alert" size={15}/><div>{error || wallet.error}</div></div>}
    <p className="field-help">ME identity status indicates the configured account binding policy only. It does not prove that a particular report was written without AI assistance.</p>
  </Modal>;
}
