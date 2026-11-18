"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, downloadJson, errorMessage, mutationOptions } from "@/lib/api";
import { apiDownloadUrl, formatAtoms, formatDate, shortId, taskLabel, wordCount } from "@/lib/format";
import { CHANNELS, type Balances, type ExportRecord, type Health, type Notice, type ReportInput, type Role, type Session, type Task, type TaskInput } from "@/lib/types";
import Icon from "./Icon";
import CreateTaskDialog from "./CreateTaskDialog";
import Modal from "./Modal";
import ReviewDesk from "./ReviewDesk";
import type { AiResult } from "./ReviewEditor";

type View = "desk" | "verify" | "workspace";
type VerifiedExport = { record: ExportRecord; taskId: string; versionId: string };

export default function Dashboard() {
  const [view, setView] = useState<View>("desk");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [healthError, setHealthError] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [balances, setBalances] = useState<Balances | null>(null);
  const [balanceError, setBalanceError] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createInitial, setCreateInitial] = useState<Partial<TaskInput> | undefined>();
  const [walletOpen, setWalletOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [editText, setEditText] = useState<string | null>(null);
  const [editError, setEditError] = useState("");
  const [disputeText, setDisputeText] = useState<string | null>(null);
  const [disputeError, setDisputeError] = useState("");
  const [verifiedExport, setVerifiedExport] = useState<VerifiedExport | null>(null);
  const [receipt, setReceipt] = useState<unknown>(null);
  const [verifyVersionId, setVerifyVersionId] = useState("");
  const [verifyError, setVerifyError] = useState("");
  const [, setClockTick] = useState(0);
  const identityEpoch = useRef(0);
  const listSequence = useRef(0);
  const requestKeys = useRef(new Map<string, string>());
  const sessionUserId = useRef<string | null>(null);
  sessionUserId.current = session?.user?.id || null;
  const selectedTask = tasks.find(task => task.id === selectedId) || null;
  const user = session?.user || null;
  const isBuyer = user?.role === "buyer";
  const disabled = Boolean(pending) || initialLoading;
  const displayedTasks = tasks.filter(task => `${task.title} ${task.id} ${task.channel}`.toLowerCase().includes(search.toLowerCase()));
  const isDemo = health?.mode === "demo";

  const bootstrap = useCallback(async () => {
    setInitialLoading(true); setHealthError("");
    const epoch = identityEpoch.current;
    const results = await Promise.allSettled([api<Health>("/health"), api<Session>("/session")]);
    if (epoch !== identityEpoch.current) return;
    if (results[0].status === "fulfilled") setHealth(results[0].value);
    else { setHealth(null); setHealthError(errorMessage(results[0].reason)); }
    if (results[1].status === "fulfilled") {
      // A session may change in another tab. Do not render its user over the previous user's private data.
      if (sessionUserId.current && sessionUserId.current !== (results[1].value.user?.id || null)) clearPrivateState();
      setSession(results[1].value);
    }
    else { clearPrivateState(); setSession(null); setHealthError(errorMessage(results[1].reason)); }
    setInitialLoading(false);
  }, []);
  useEffect(() => { void bootstrap(); }, [bootstrap]);
  useEffect(() => { const timer = setInterval(() => setClockTick(value => value + 1), 30000); return () => clearInterval(timer); }, []);

  const refreshBalances = useCallback(async () => {
    if (!session?.user) return;
    const epoch = identityEpoch.current;
    try { const result = await api<Balances>("/balances"); if (epoch === identityEpoch.current) { setBalances(result); setBalanceError(""); } }
    catch (error) { if (epoch === identityEpoch.current) { setBalances(null); setBalanceError(errorMessage(error)); } }
  }, [session?.user]);

  const refreshWorkspace = useCallback(async () => {
    if (!session?.user) return;
    const epoch = identityEpoch.current, sequence = ++listSequence.current;
    setListLoading(true); setListError("");
    const results = await Promise.allSettled([api<{ tasks: Task[] }>("/tasks"), api<Balances>("/balances")]);
    if (epoch !== identityEpoch.current || sequence !== listSequence.current) return;
    if (results[0].status === "fulfilled") {
      const next = results[0].value.tasks;
      setTasks(next); setSelectedId(current => current && next.some(task => task.id === current) ? current : next[0]?.id || null);
    } else { setTasks([]); setSelectedId(null); setListError(errorMessage(results[0].reason)); }
    if (results[1].status === "fulfilled") { setBalances(results[1].value); setBalanceError(""); }
    else { setBalances(null); setBalanceError(errorMessage(results[1].reason)); }
    setListLoading(false);
  }, [session?.user]);
  useEffect(() => { if (session?.user) void refreshWorkspace(); }, [session?.user?.id, refreshWorkspace]);
  useEffect(() => { setVerifyVersionId(selectedTask?.currentVersionId || ""); setVerifyError(""); }, [selectedTask?.id, selectedTask?.currentVersionId]);

  function clearPrivateState() {
    identityEpoch.current += 1; listSequence.current += 1; requestKeys.current.clear();
    setTasks([]); setSelectedId(null); setBalances(null); setListError(""); setBalanceError(""); setNotice(null); setSearch("");
    setVerifiedExport(null); setReceipt(null); setVerifyVersionId(""); setVerifyError(""); setCreateOpen(false); setEditText(null); setDisputeText(null);
    setSession(current => current ? { ...current, user: null, csrfToken: null } : null);
  }
  async function switchRole(role: Role) {
    if (pending || !isDemo) return;
    clearPrivateState(); setPending(`login:${role}`); setListLoading(false);
    try { const result = await api<Session>("/demo/session", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ role }) }); setSession(result); }
    catch (error) { setNotice({ kind: "error", message: errorMessage(error) }); }
    finally { setPending(null); }
  }
  async function post<T>(path: string, body: unknown): Promise<T> {
    const signature = JSON.stringify([session?.user?.id, path, body]);
    let key = requestKeys.current.get(signature);
    if (!key) { key = crypto.randomUUID(); requestKeys.current.set(signature, key); }
    try { const result = await api<T>(path, mutationOptions(session?.csrfToken, body, key)); requestKeys.current.delete(signature); return result; }
    catch (error) { if (error instanceof ApiError && error.status >= 400 && error.status < 500) requestKeys.current.delete(signature); throw error; }
  }
  async function logout() {
    if (pending || !user) return;
    setPending("logout");
    try { await post("/logout", {}); clearPrivateState(); setNotice({ kind: "success", message: "Signed out. Private task and receipt data has been cleared from this view." }); }
    catch (error) { setNotice({ kind: "error", message: errorMessage(error) }); }
    finally { setPending(null); }
  }
  function applyTask(task: Task) { setTasks(current => current.some(item => item.id === task.id) ? current.map(item => item.id === task.id ? task : item) : [task, ...current]); setSelectedId(task.id); }
  async function createTask(input: TaskInput) {
    const epoch = identityEpoch.current; setPending("create");
    try { const result = await post<{ task: Task }>("/tasks", input); if (epoch === identityEpoch.current) { applyTask(result.task); setCreateOpen(false); setView("desk"); setNotice({ kind: "success", message: "Review created. Request a fixed quote when the brief is ready." }); } }
    finally { if (epoch === identityEpoch.current) setPending(null); }
  }
  async function mutateTask(action: string, body: Record<string, unknown> = {}, message = "Task updated.", rethrow = false) {
    if (!selectedTask || pending) return;
    const epoch = identityEpoch.current; setPending(action); setNotice(null);
    try {
      const result = await post<{ task: Task }>(`/tasks/${encodeURIComponent(selectedTask.id)}/${action}`, { expectedVersion: selectedTask.version, ...body });
      if (epoch === identityEpoch.current) { applyTask(result.task); setNotice({ kind: "success", message }); await refreshBalances(); }
    } catch (error) {
      if (epoch === identityEpoch.current) {
        setNotice({ kind: "error", message: errorMessage(error) });
        if (error instanceof ApiError && error.status === 409) await refreshWorkspace();
      }
      if (rethrow) throw error;
    } finally { if (epoch === identityEpoch.current) setPending(null); }
  }
  async function aiChecks(): Promise<AiResult> {
    if (!selectedTask) throw new Error("Select a task first.");
    return post<AiResult>(`/tasks/${encodeURIComponent(selectedTask.id)}/ai-checks`, {});
  }
  async function submitReview(input: ReportInput) { await mutateTask("reviews", input as unknown as Record<string, unknown>, "Human review delivered. Switch to Brand to accept the service and separately approve a PASS version.", true); }
  async function exportVersion(versionId?: string) {
    if (!selectedTask?.approval || pending) return;
    const task = selectedTask, epoch = identityEpoch.current;
    setPending("export"); setVerifyError(""); setNotice(null); setVerifiedExport(null); setReceipt(null);
    try {
      const result = await post<{ export: ExportRecord }>("/exports", { taskId: task.id, versionId: versionId || task.currentVersionId, approvalId: task.approval!.id });
      if (epoch === identityEpoch.current) { setVerifiedExport({ record: result.export, taskId: task.id, versionId: versionId || task.currentVersionId }); setView("verify"); setNotice({ kind: "success", message: "The API verified this exact version and created a local demo export. No ME attestation was issued." }); }
    } catch (error) { if (epoch === identityEpoch.current) { setVerifyError(errorMessage(error)); setNotice({ kind: "error", message: errorMessage(error) }); } }
    finally { if (epoch === identityEpoch.current) setPending(null); }
  }
  async function readReceipt() {
    if (!verifiedExport || pending) return;
    const epoch = identityEpoch.current; setPending("receipt");
    try { const result = await api<unknown>(`/exports/${encodeURIComponent(verifiedExport.record.id)}/receipt`); if (epoch === identityEpoch.current) setReceipt(result); }
    catch (error) { if (epoch === identityEpoch.current) setNotice({ kind: "error", message: errorMessage(error) }); }
    finally { if (epoch === identityEpoch.current) setPending(null); }
  }
  async function withdraw() {
    const epoch = identityEpoch.current; setPending("withdraw"); setNotice(null);
    try { const result = await post<Balances>("/withdrawals", {}); if (epoch === identityEpoch.current) { setBalances(result); setNotice({ kind: "success", message: "Local DEMO credits withdrawn in the isolated ledger. No cryptocurrency was transferred." }); } }
    catch (error) { if (epoch === identityEpoch.current) setNotice({ kind: "error", message: errorMessage(error) }); }
    finally { if (epoch === identityEpoch.current) setPending(null); }
  }
  function navigate(next: View) { setView(next); setMobileOpen(false); }
  function duplicateTask() { if (!selectedTask) return; setCreateInitial({ title: `${selectedTask.title} · next review`.slice(0, 120), facts: selectedTask.facts, sourceText: selectedTask.versions.find(v => v.id === selectedTask.currentVersionId)?.text || selectedTask.sourceText, channel: selectedTask.channel, locale: "en-US" }); setCreateOpen(true); }
  const navItems: { id: View; icon: "grid" | "shield" | "wallet"; label: string }[] = [{ id: "desk", icon: "grid", label: "Review desk" }, { id: "verify", icon: "shield", label: "Export & verify" }, { id: "workspace", icon: "wallet", label: "Workspace" }];

  return <div className="app-shell">
    <div className={`mobile-backdrop ${mobileOpen ? "visible" : ""}`} onClick={() => setMobileOpen(false)} aria-hidden="true"/>
    <aside className={`sidebar ${mobileOpen ? "open" : ""}`} aria-label="Primary navigation">
      <button className="icon-btn sidebar-close" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><Icon name="close"/></button>
      <a href="/" className="brand" aria-label="HumanDock home"><span className="brand-mark"><Icon name="anchor" size={21}/></span><span className="brand-word">Human<span>Dock</span></span></a>
      <div className="nav-label">YOUR WORKSPACE</div><nav className="nav-list">{navItems.map(item => <button className={`nav-item ${view === item.id ? "active" : ""}`} key={item.id} onClick={() => navigate(item.id)} aria-label={item.label} aria-current={view === item.id ? "page" : undefined}><Icon name={item.icon} size={17}/>{item.label}{item.id === "desk" && tasks.length > 0 && <span className="nav-count">{tasks.length}</span>}</button>)}</nav>
      <div className="sidebar-spacer"/>
      <div className="sidebar-note"><Icon name="shield" className="note-icon" size={22}/><h3>Human judgment.<br/>A record you can check.</h3><p>Review the work. Approve the version.<br/>Keep the two decisions separate.</p></div>
      <div className="sidebar-footer"><div className="avatar dark">{user ? user.name.slice(0, 2).toUpperCase() : "HD"}</div><div><div className="profile-label">{user?.name || "Your review desk"}</div><div className="profile-sub">{user ? `${user.role} · local test identity` : "Choose a demo role to begin"}</div></div>{user && <button className="icon-btn" style={{ marginLeft: "auto", color: "#95a8ac", padding: 3 }} onClick={() => void logout()} disabled={disabled} aria-label="Sign out"><Icon name="logout" size={14}/></button>}</div>
    </aside>
    <main className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="icon-btn mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Icon name="menu" size={19}/></button><span className="breadcrumb-root">Workspace</span><Icon name="chevron" size={11}/><strong>{navItems.find(item => item.id === view)?.label}</strong></div><div className="topbar-status"><span className="api-label"><span className={`status-dot ${health?.ok ? "online" : ""}`}/>{health?.ok ? "API connected" : initialLoading ? "Connecting…" : "API offline"}</span><span className="divider"/><span className="me-label"><span className="status-dot"/>ME not verified</span><button className="btn small" onClick={() => setWalletOpen(true)}><Icon name="wallet" size={12}/>ME connection</button></div></header>
      <div className="heading-row"><div><div className="eyebrow coral"><span style={{ width: 13, height: 1, background: "currentColor" }}/> A LITTLE HUMAN, A LOT MORE CERTAIN</div><h1 className="page-title">{view === "desk" ? "Good copy. A human second look." : view === "verify" ? "Know exactly what was approved." : "The people behind the work."}</h1><p>{view === "desk" ? "One clear brief. Independent review. Your final say." : view === "verify" ? "Check the exact version, approval, and scope before export." : "Your test identity, local ledger, and integration readiness."}</p></div>{view === "desk" && <div className="heading-actions"><button className="btn primary" onClick={() => { setCreateInitial(undefined); setCreateOpen(true); }} disabled={!isBuyer || disabled} title={!isBuyer ? "Choose the Brand demo role to create a review" : "Create a review"}><Icon name="plus" size={15}/>New review</button></div>}</div>
      <section className="mode-bar" aria-label="Demo mode and role selection"><div className="mode-label"><Icon name="code" size={15}/><div><strong>{health?.mode === "me" ? "ME integration is gated" : "Local demonstration"}</strong> — {health?.mode === "me" ? "Live wallet actions are not enabled in this MVP." : "DEMO credits only. No real funds or ME identity certification."}<small>本地演示 · 身份、资金与证明均未接入真实 ME 网络</small></div></div><div className="role-switch"><span className="role-caption">VIEW AS</span>{([{ role: "buyer", label: "Brand" }, { role: "reviewer", label: "Reviewer" }, { role: "outsider", label: "Other org" }] as { role: Role; label: string }[]).map(item => <button key={item.role} className={user?.role === item.role ? "selected" : ""} disabled={!isDemo || disabled} onClick={() => void switchRole(item.role)} aria-pressed={user?.role === item.role}>{pending === `login:${item.role}` ? "Signing in…" : item.label}</button>)}</div></section>
      {healthError && <div className="toast error" role="alert"><Icon name="alert" size={16}/><div><strong>The API is not available.</strong><br/>{healthError}</div><button className="btn small" onClick={() => void bootstrap()} disabled={initialLoading}>{initialLoading ? "Connecting…" : "Retry"}</button></div>}
      {notice && <div className={`toast ${notice.kind === "error" ? "error" : ""}`} role={notice.kind === "error" ? "alert" : "status"}><Icon name={notice.kind === "error" ? "alert" : "check"} size={15}/><div>{notice.message}</div><button className="icon-btn" onClick={() => setNotice(null)} aria-label="Dismiss message"><Icon name="close" size={14}/></button></div>}

      {view === "desk" && <>
        <div className="section-heading"><h2>Review queue <span className="count-label">{tasks.length}</span></h2><div className="list-toolbar">{tasks.length > 2 && <div className="list-search"><Icon name="search" size={13}/><input aria-label="Search tasks" placeholder="Find a review…" value={search} onChange={e => setSearch(e.target.value)}/></div>}<button className="icon-btn" onClick={() => void refreshWorkspace()} disabled={!user || disabled || listLoading} aria-label="Refresh tasks"><Icon name="refresh" size={14}/></button></div></div>
        <section className="panel">
          {initialLoading || listLoading ? <div aria-label="Loading tasks" role="status">{[0, 1].map(n => <div className="skeleton-row" key={n}><div className="skeleton"/><div className="skeleton"/><div className="skeleton"/></div>)}</div> : listError ? <div className="empty-state"><div className="empty-icon"><Icon name="alert" size={22}/></div><h3>We couldn’t load your queue.</h3><p>{listError}</p><button className="btn" onClick={() => void refreshWorkspace()}>Try again</button></div> : !user ? <div className="empty-state"><div className="empty-icon"><Icon name="anchor" size={24}/></div><h3>Your next good draft starts here.</h3><p>Choose Brand to create a review, then switch to Reviewer to complete it. Every task and receipt stays in this local demo.</p><div className="button-row"><button className="btn primary" disabled={!isDemo || disabled} onClick={() => void switchRole("buyer")}><Icon name="arrow" size={13}/>Enter as Brand</button><button className="btn" onClick={() => navigate("workspace")}>Explore the workflow</button></div></div> : displayedTasks.length === 0 ? <div className="empty-state"><div className="empty-icon"><Icon name="file" size={23}/></div><h3>{search ? "No matching reviews." : user.role === "reviewer" ? "No funded assignments yet." : user.role === "outsider" ? "A different organization. A private queue." : "A clean desk. A fresh perspective."}</h3><p>{search ? "Try a different title or clear the search." : user.role === "reviewer" ? "The brand must fund a task before its invited reviewer can see and accept it." : user.role === "outsider" ? "This test identity has no access to the Brand organization’s tasks, reports, or exports." : "Create a short US English copy review. Start with your own approved material or load a clearly labelled fictional example."}</p>{isBuyer && <button className="btn primary" onClick={() => { setCreateInitial(undefined); setCreateOpen(true); }} disabled={disabled}><Icon name="plus" size={13}/>Create your first review</button>}</div> : <div className="task-table-container"><table className="task-list"><thead><tr><th>Review</th><th>Stage</th><th className="optional-column">Channel</th><th>Updated</th><th><span className="screen-reader">Open</span></th></tr></thead><tbody>{displayedTasks.map(task => <tr className={selectedId === task.id ? "selected" : ""} key={task.id} onClick={() => setSelectedId(task.id)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedId(task.id); } }} tabIndex={0} aria-label={`Open ${task.title}`}><td><div className="task-title-cell"><div className="task-glyph"><Icon name="file" size={16}/></div><div><div className="task-title">{task.title}</div><div className="task-sub">US English <span style={{ margin: "0 4px" }}>·</span><span className="mono">{shortId(task.id, 5)}</span></div></div></div></td><td><span className={`badge ${task.status === "DISPUTED" ? "red" : task.report ? "green" : task.status === "ASSIGNED" ? "coral" : "neutral"}`}>{taskLabel(task)}</span></td><td className="optional-column muted">{CHANNELS[task.channel]}</td><td className="muted tiny">{formatDate(task.updatedAt)}</td><td><Icon name="chevron" size={13} style={{ color: "#bdc5b6" }}/></td></tr>)}</tbody></table></div>}
        </section>
        {selectedTask && user && <ReviewDesk task={selectedTask} user={user} pending={pending} aiMode={health?.ai.mode || "rules"} onMutate={mutateTask} onAiChecks={aiChecks} onReview={submitReview} onExport={() => exportVersion()} onNewVersion={() => { setEditText(selectedTask.versions.find(v => v.id === selectedTask.currentVersionId)?.text || selectedTask.sourceText); setEditError(""); }} onDispute={() => { setDisputeText(""); setDisputeError(""); }} onDuplicate={duplicateTask}/>}
      </>}

      {view === "verify" && <>
        <section className="panel receipt-panel"><div className="eyebrow coral">EXACT VERSION / EXPLICIT APPROVAL</div><h2>A receipt for what actually happened.</h2><p>The API checks ownership, the approved content version, PASS verdict, scope, expiry, and revocation. It does not certify that the copy is true or legally compliant. These receipts are local demonstrations, not ME attestations.</p>
          <div className="verify-form"><div className="form-grid"><div className="form-field"><label htmlFor="verify-task">Review task</label><select id="verify-task" value={selectedId || ""} onChange={e => setSelectedId(e.target.value)} disabled={!user || disabled || tasks.length === 0}><option value="">Choose a review…</option>{tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></div><div className="form-field"><label htmlFor="verify-version">Content version</label><select id="verify-version" value={verifyVersionId} onChange={e => { setVerifyVersionId(e.target.value); setVerifyError(""); }} disabled={!selectedTask || disabled}>{selectedTask?.versions.map((version, index) => <option key={version.id} value={version.id}>Version {index + 1}{version.id === selectedTask.currentVersionId ? " · current" : ""}{version.id === selectedTask.approval?.versionId ? " · approved" : ""}</option>)}</select></div></div>
          <div className="button-row"><button className="btn primary" disabled={!isBuyer || !selectedTask?.approval || !verifyVersionId || disabled} onClick={() => void exportVersion(verifyVersionId)}>{pending === "export" ? <span className="spinner"/> : <Icon name="shield" size={14}/>}Check &amp; create export</button><span className="toolbar-message">{!user ? "Choose a demo role first." : !isBuyer ? "Only the brand owner can export private content." : !selectedTask?.approval ? "Approve a PASS-reviewed version in the review desk first." : "Trying a changed version will test the API’s approval boundary."}</span></div></div>
          {verifyError && <div className="verify-result invalid" role="alert"><h3><Icon name="lock" size={16}/>Export was refused.</h3><p>{verifyError}</p><p>No verified export was created for this request.</p></div>}
        </section>
        {verifiedExport && <div className="verification-grid"><section className="panel receipt-detail"><div className="eyebrow">LOCAL DEMO EXPORT</div><h3><Icon name="check" size={14} style={{ verticalAlign: "middle", marginRight: 7, color: "var(--green)" }}/>Exact version checked</h3><div className="receipt-line"><span>File</span><span>{verifiedExport.record.filename}</span></div><div className="receipt-line"><span>Export ID</span><span className="mono">{shortId(verifiedExport.record.id, 10)}</span></div><div className="receipt-line"><span>Version</span><span className="mono">{shortId(verifiedExport.versionId, 10)}</span></div><div className="receipt-line"><span>Checked</span><span>{formatDate(verifiedExport.record.verifiedAt, true)}</span></div><div className="subtle-callout">LOCAL DEMO / NOT A ME ATTESTATION. Downloads re-check the current approval. Repeated downloads do not charge again.</div><div className="button-row"><a className="btn primary" href={apiDownloadUrl(verifiedExport.record.downloadUrl)} download><Icon name="download" size={13}/>Download exact copy</a><button className="btn" onClick={() => void readReceipt()} disabled={disabled}>{pending === "receipt" ? <span className="spinner"/> : <Icon name="eye" size={13}/>}Read private receipt</button></div></section><section className="panel receipt-detail"><h3>The verification record</h3>{receipt ? <><pre>{JSON.stringify(receipt, null, 2)}</pre><button className="btn small" onClick={() => downloadJson(receipt, `humandock-demo-receipt-${verifiedExport.record.id}.json`)}><Icon name="download" size={12}/>Save receipt JSON</button></> : <div className="report-placeholder"><Icon name="file" size={27}/><h4>Open the private receipt.</h4><p>It contains the actual API verification record, clearly marked as a local demo.</p></div>}</section></div>}
      </>}

      {view === "workspace" && <div className="workspace-grid">
        <section className="panel workspace-card"><div className="eyebrow">01 / IDENTITY</div><h3>A person, a role, a clear boundary.</h3><p>Demo identities test authorization. They do not claim ME verification, English expertise, or proof of human authorship.</p><dl className="definition-list"><div><dt>Account</dt><dd>{user?.name || "Not signed in"}</dd></div><div><dt>Role</dt><dd>{user?.role || "—"}</dd></div><div><dt>Organization</dt><dd className="mono">{shortId(user?.orgId, 12)}</dd></div><div><dt>Identity</dt><dd>{user?.identity.label || "No identity checked"}</dd></div><div><dt>Skill qualification</dt><dd>Not independently verified in demo</dd></div></dl><button className="btn" style={{ marginTop: 15 }} onClick={() => setWalletOpen(true)}><Icon name="wallet" size={13}/>Why is ME not connected?</button></section>
        <section className="panel workspace-card"><div className="eyebrow">02 / LOCAL LEDGER</div><h3>Allocated is not withdrawn.</h3><p>These are isolated DEMO credits. No real cryptocurrency, ME wallet payment, or blockchain transaction is represented here.</p>{balanceError ? <div className="form-error-inline" style={{ marginTop: 17 }}>{balanceError}<button className="btn small" style={{ marginLeft: 10 }} onClick={() => void refreshBalances()} disabled={disabled}>Retry</button></div> : balances ? <><div className="balance-line" style={{ marginTop: 18 }}><span>Available to withdraw</span><strong>{formatAtoms(balances.claimableAtoms)} DEMO</strong></div><div className="balance-line"><span>Already withdrawn</span><strong>{formatAtoms(balances.withdrawnAtoms)} DEMO</strong></div><div className="balance-line"><span>In escrow</span><strong>{formatAtoms(balances.escrowedAtoms)} DEMO</strong></div><p className="balance-note">Settlement allocates credits. The separate withdrawal below moves only local test credits in the demo ledger.</p><button className="btn navy" disabled={disabled || !/^\d+$/.test(balances.claimableAtoms) || BigInt(balances.claimableAtoms) === 0n} onClick={() => void withdraw()}>{pending === "withdraw" ? <span className="spinner"/> : <Icon name="download" size={13}/>}Withdraw DEMO credits</button></> : <div className="subtle-callout">Sign in with a local demo role to see its actual ledger balance.</div>}</section>
        <section className="panel workspace-card"><div className="eyebrow">03 / READINESS</div><h3>Integration, honestly reported.</h3><dl className="definition-list"><div><dt>Application mode</dt><dd>{health?.mode || "Unavailable"}</dd></div><div><dt>API</dt><dd>{health?.ok ? "Connected" : "Not connected"}</dd></div><div><dt>Storage</dt><dd>{health?.storage || "Unknown"}</dd></div><div><dt>Assistance</dt><dd>{health?.ai.mode === "rules" ? "Local rules · no live AI model" : health?.ai.mode === "provider" ? "Configured AI provider" : "Unknown"}</dd></div><div><dt>ME network</dt><dd>{health?.chain.status === "configured_unverified" ? "Configured, not verified" : "Not configured"}</dd></div><div><dt>ME ID</dt><dd>Not verified</dd></div><div><dt>Build</dt><dd>{health?.version || "MVP"}</dd></div></dl><button className="btn small" style={{ marginTop: 14 }} onClick={() => void bootstrap()} disabled={initialLoading || disabled}><Icon name="refresh" size={12}/>Refresh readiness</button></section>
        <section className="panel workspace-card"><div className="eyebrow">04 / HOW TO TRY IT</div><h3>Four decisions. One accountable workflow.</h3><div className="definition-list"><div><dt>01 · Brand</dt><dd>Create a brief, request a quote, fund with DEMO credits.</dd></div><div><dt>02 · Reviewer</dt><dd>Accept the assignment, assess all five criteria, submit a report.</dd></div><div><dt>03 · Brand</dt><dd>Accept the service. Separately approve a PASS-reviewed version.</dd></div><div><dt>04 · Verify</dt><dd>Export exact copy. Change a version and test the refusal.</dd></div></div><p style={{ marginTop: 13 }}>Use Other org to confirm that another organization cannot see the Brand’s tasks. 中文：切换身份完成闭环；服务验收、内容批准分别操作。</p></section>
        {balances && balances.entries.length > 0 && <section className="panel workspace-card" style={{ gridColumn: "1 / -1" }}><div className="eyebrow">LOCAL DEMO / ACTUAL LEDGER ENTRIES</div><h3>Credit history</h3><div className="activity-list" style={{ marginTop: 18 }}>{balances.entries.map(entry => <div className="activity-row" key={entry.id}><span className="activity-dot"/><div className="activity-body"><strong>{entry.type.replaceAll("_", " ")}</strong><div className="sublabel">{entry.taskId ? `Task ${shortId(entry.taskId, 6)}` : "Account ledger"}</div></div><span className="tiny" style={{ marginLeft: "auto", color: "#7c9871" }}>{formatAtoms(entry.amountAtoms)} DEMO</span><time className="activity-time">{formatDate(entry.at, true)}</time></div>)}</div></section>}
      </div>}
      <footer className="footer"><span>HumanDock <span className="footer-dot">·</span>Built for work worth a second look.</span><button className="btn ghost small" style={{ padding: 0, minHeight: 0, fontSize: 9, color: "inherit" }} onClick={() => navigate("workspace")}>Local MVP boundaries <Icon name="arrow" size={11}/></button></footer>
    </main>
    {createOpen && <CreateTaskDialog onClose={() => setCreateOpen(false)} onCreate={createTask} initial={createInitial}/>}
    {walletOpen && <Modal title="ME connection is not ready." subtitle="No wallet permission or signature has been requested." onClose={() => setWalletOpen(false)} footer={<><p>Current state: {health?.chain.status || "API unavailable"}</p><button className="btn navy" onClick={() => { setWalletOpen(false); navigate("workspace"); }}>View readiness</button></>}><div className="wallet-explanation"><Icon name="wallet" size={31} style={{ color: "var(--coral)" }}/><h3>This MVP runs an isolated local demonstration.</h3><p>Real wallet actions stay unavailable until the ME network, deployed contracts, identity integration, and transaction checks are configured and verified.</p><ul><li>Local test accounts are not ME ID-certified people.</li><li>DEMO credits have no monetary value and do not move cryptocurrency.</li><li>Local receipts are not on-chain attestations.</li></ul><p>请先完成真实网络与身份接入验证，再启用钱包交易。当前按钮只解释状态，不会请求账户或签名。</p></div></Modal>}
    {editText !== null && selectedTask && <Modal title="A new version needs its own approval." subtitle="The original review and approval remain immutable." busy={Boolean(pending)} onClose={() => setEditText(null)} footer={<><p>Changing one character is enough to invalidate reuse of the previous version’s approval.</p><div className="button-row"><button className="btn" disabled={Boolean(pending)} onClick={() => setEditText(null)}>Cancel</button><button className="btn primary" disabled={Boolean(pending) || !editText.trim() || wordCount(editText) > 300 || editText === (selectedTask.versions.find(v => v.id === selectedTask.currentVersionId)?.text || selectedTask.sourceText)} onClick={async () => { setEditError(""); try { await mutateTask("versions", { text: editText }, "New content version saved. It does not inherit the old review or approval.", true); setEditText(null); } catch (error) { setEditError(errorMessage(error)); } }}>{pending === "versions" ? <span className="spinner"/> : <Icon name="edit" size={13}/>}Save new version</button></div></>}><div className="form-notice">This creates a new immutable version. Try “Check &amp; export current” afterward to see the API refuse reuse of the old approval.</div>{editError && <div className="form-error-inline" role="alert">{editError}</div>}<label htmlFor="changed-copy">Changed copy</label><textarea id="changed-copy" className="version-editor" maxLength={6000} value={editText} onChange={e => setEditText(e.target.value)} disabled={Boolean(pending)}/><p className={wordCount(editText) > 300 ? "field-error" : "field-help"}>{wordCount(editText)}/300 words</p></Modal>}
    {disputeText !== null && selectedTask && <Modal title="Tell us what wasn’t delivered." subtitle="Disputes concern the agreed review service, not whether you liked the verdict." busy={Boolean(pending)} onClose={() => setDisputeText(null)} footer={<><p>After 72h without arbitration, the agreed demo fallback splits reviewer pay and returns the platform fee.</p><button className="btn danger" disabled={Boolean(pending) || disputeText.trim().length < 10} onClick={async () => { setDisputeError(""); try { await mutateTask("disputes", { reason: disputeText.trim() }, "Dispute recorded. Service funds remain held until an eligible resolution.", true); setDisputeText(null); } catch (error) { setDisputeError(errorMessage(error)); } }}>{pending === "disputes" ? <span className="spinner"/> : <Icon name="alert" size={13}/>}Submit dispute</button></>}><div className="form-notice">A BLOCK or CHANGES REQUIRED verdict is not itself grounds for non-payment. Describe a specific unmet part of the agreed rubric, missing report, or delivery issue.</div>{disputeError && <div className="form-error-inline" role="alert">{disputeError}</div>}<label htmlFor="dispute-reason">Reason and evidence</label><textarea id="dispute-reason" rows={5} value={disputeText} onChange={e => setDisputeText(e.target.value)} placeholder="Which agreed review requirement was not completed?" maxLength={2000} disabled={Boolean(pending)}/><p className="field-help">At least 10 characters. The server enforces the challenge deadline.</p></Modal>}
  </div>;
}
