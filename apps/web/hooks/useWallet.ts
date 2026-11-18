"use client";
import { useEffect, useRef, useState } from "react";
import { addWalletChain, connectWallet, discoverWallets, isAddress, parseChain, sameAddress, switchWalletChain, walletError, type WalletChain, type WalletChoice, type WalletSnapshot } from "@/lib/wallet";

export function useWallet(enabled: boolean, onAccountInvalidated: (message: string) => void) {
  const [choices, setChoices] = useState<WalletChoice[]>([]);
  const [selected, setSelected] = useState<WalletChoice | null>(null);
  const [snapshot, setSnapshot] = useState<WalletSnapshot | null>(null);
  const [busy, setBusy] = useState<"connect" | "switch" | "add" | null>(null);
  const [error, setError] = useState("");
  const [missingNetwork, setMissingNetwork] = useState(false);
  const invalidateRef = useRef(onAccountInvalidated);
  const snapshotRef = useRef(snapshot);
  const generation = useRef(0);
  invalidateRef.current = onAccountInvalidated;
  snapshotRef.current = snapshot;

  useEffect(() => { if (enabled) return discoverWallets(setChoices); }, [enabled]);
  useEffect(() => {
    if (!selected) return;
    const provider = selected.provider;
    const accountsChanged = (...args: unknown[]) => {
      const accounts = args[0];
      const address = Array.isArray(accounts) && isAddress(accounts[0]) ? accounts[0] : null;
      const previous = snapshotRef.current;
      if (!address || (previous && !sameAddress(previous.address, address))) {
        generation.current += 1;
        setSnapshot(previous && address ? { ...previous, address } : null);
        setError(""); setBusy(null);
        invalidateRef.current(address ? "The active wallet account changed. Your previous private workspace was cleared. Sign in with this account to continue." : "The wallet disconnected this account. Your private workspace was cleared.");
      }
    };
    const chainChanged = (...args: unknown[]) => {
      generation.current += 1; setBusy(null);
      try { const chainId = parseChain(args[0]); setSnapshot(current => current ? { ...current, chainId } : current); setMissingNetwork(false); setError(""); }
      catch (err) { setSnapshot(null); setError(walletError(err).message); invalidateRef.current("The wallet reported an invalid network. Reconnect before continuing."); }
    };
    const disconnected = () => { generation.current += 1; setSnapshot(null); setBusy(null); invalidateRef.current("The wallet disconnected. Your private workspace was cleared."); };
    provider.on?.("accountsChanged", accountsChanged);
    provider.on?.("chainChanged", chainChanged);
    provider.on?.("disconnect", disconnected);
    return () => { provider.removeListener?.("accountsChanged", accountsChanged); provider.removeListener?.("chainChanged", chainChanged); provider.removeListener?.("disconnect", disconnected); };
  }, [selected]);

  async function connect(choice: WalletChoice) {
    if (busy) return;
    const attempt = ++generation.current;
    setBusy("connect"); setError("");
    try {
      const next = await connectWallet(choice.provider);
      if (attempt !== generation.current) return;
      if (snapshotRef.current && !sameAddress(snapshotRef.current.address, next.address)) invalidateRef.current("The connected wallet account changed. Sign in again to load its workspace.");
      setSelected(choice); setSnapshot(next); setMissingNetwork(false);
    } catch (err) { if (attempt === generation.current) setError(walletError(err).message); }
    finally { if (attempt === generation.current) setBusy(null); }
  }
  async function switchNetwork(chainId: number) {
    if (!selected || busy) return;
    setBusy("switch"); setError("");
    try { const next = await switchWalletChain(selected.provider, chainId); setSnapshot(current => current ? { ...current, chainId: next } : current); setMissingNetwork(false); }
    catch (err) { const normalized = walletError(err); setError(normalized.message); setMissingNetwork(normalized.code === 4902); }
    finally { setBusy(null); }
  }
  async function addNetwork(chain: WalletChain) {
    if (!selected || busy) return;
    setBusy("add"); setError("");
    try { await addWalletChain(selected.provider, chain); setMissingNetwork(false); setError("Network added. Use Switch network to select it before signing."); }
    catch (err) { setError(walletError(err).message); }
    finally { setBusy(null); }
  }
  function forget() { generation.current += 1; setSelected(null); setSnapshot(null); setBusy(null); setError(""); setMissingNetwork(false); }
  return { choices, selected, snapshot, busy, error, missingNetwork, connect, switchNetwork, addNetwork, forget };
}
export type WalletController = ReturnType<typeof useWallet>;
