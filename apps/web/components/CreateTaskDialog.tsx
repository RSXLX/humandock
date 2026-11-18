"use client";
import { useState, type FormEvent } from "react";
import type { Channel, Reviewer, TaskInput } from "@/lib/types";
import { CHANNELS } from "@/lib/types";
import { wordCount } from "@/lib/format";
import { errorMessage } from "@/lib/api";
import Modal from "./Modal";
import Icon from "./Icon";

const empty: TaskInput = { title: "", facts: "", sourceText: "", channel: "instagram_text", locale: "en-US" };
const example: TaskInput = {
  title: "Tide Notes · US launch copy",
  facts: "Fictional product: Tide Notes, a note-taking web app.\nConfirmed features: searchable notes, folders, and markdown export.\nThe free plan supports up to 100 notes.\nNo offline access. No published security certifications.\nAudience: independent designers. Voice: friendly, calm, and specific.",
  sourceText: "Your best ideas deserve a home. Meet Tide Notes, the world's most secure workspace for every thought. Save unlimited notes, work anywhere offline, and find your next big idea in seconds. Try it free today.",
  channel: "instagram_text", locale: "en-US",
};
export default function CreateTaskDialog({ onClose, onCreate, initial, mode = "demo", reviewers = [], reviewersLoading = false, reviewersError = "", onRefreshReviewers }: { onClose: () => void; onCreate: (input: TaskInput) => Promise<void>; initial?: Partial<TaskInput>; mode?: "demo" | "me"; reviewers?: Reviewer[]; reviewersLoading?: boolean; reviewersError?: string; onRefreshReviewers?: () => Promise<void> }) {
  const [form, setForm] = useState<TaskInput>({ ...empty, ...initial });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [sample, setSample] = useState(false);
  const count = wordCount(form.sourceText);
  const valid = form.title.trim().length >= 3 && form.title.trim().length <= 120 && form.facts.trim().length >= 10 && form.sourceText.trim() && count <= 300 && form.facts.length <= 2000 && (mode === "demo" || reviewers.some(reviewer => reviewer.wallet === form.reviewerWallet));
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!valid || pending) return;
    setPending(true); setError("");
    try { await onCreate({ ...form, title: form.title.trim(), facts: form.facts.trim(), sourceText: form.sourceText.trim() }); }
    catch (err) { setError(errorMessage(err)); }
    finally { setPending(false); }
  }
  return <Modal title="Give your copy a second look." subtitle="Create a US English text review · 创建一份英文文案审核" onClose={onClose} busy={pending} footer={<><p>{mode === "demo" ? "Saved to the local demo workspace. No ME payment or identity verification occurs." : "Creates a private draft. No wallet payment is requested until you review and fund a quote."}</p><div className="button-row"><button className="btn" onClick={onClose} disabled={pending}>Cancel</button><button className="btn primary" type="submit" form="create-task" disabled={!valid || pending}>{pending ? <span className="spinner"/> : <Icon name="arrow" size={14}/>}Create review</button></div></>}>
    <form id="create-task" onSubmit={submit}>
      <div className="form-notice"><strong>{mode === "demo" ? "Local demo." : "Private review brief."}</strong> Use fictional or approved, non-sensitive material. Creating a task does not fund it; you will review a quote first.</div>
      {error && <div className="toast error" role="alert"><Icon name="alert" size={15}/><div>{error}</div></div>}
      <div className="form-section-title">01 / The brief<button type="button" className="btn ghost small" disabled={pending} onClick={() => { setForm({ ...example, reviewerWallet: form.reviewerWallet }); setSample(true); }}><Icon name="spark" size={12}/>Load fictional example</button></div>
      {sample && <p className="field-help" style={{ marginBottom: 16 }}>Fictional Tide Notes example loaded. Submit below to save it as a clearly fictional review task.</p>}
      <div className="form-grid">
        <div className="form-field full-width"><label htmlFor="task-title">Review title</label><input id="task-title" minLength={3} maxLength={120} required value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="Summer launch · US English" disabled={pending}/></div>
        <div className="form-field"><label htmlFor="task-channel">Channel</label><select id="task-channel" value={form.channel} onChange={e => setForm({ ...form, channel: e.target.value as Channel })} disabled={pending}>{Object.entries(CHANNELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
        <div className="form-field"><label htmlFor="task-locale">Review language</label><input id="task-locale" value="US English · en-US" readOnly aria-readonly="true"/><p className="field-help">The MVP supports one language market.</p></div>
        {mode === "me" && <div className="form-field full-width"><label htmlFor="task-reviewer">Invited reviewer</label><select id="task-reviewer" value={form.reviewerWallet || ""} onChange={event => setForm({ ...form, reviewerWallet: event.target.value })} required disabled={pending || reviewersLoading}><option value="">{reviewersLoading ? "Loading configured reviewers…" : "Choose a configured reviewer…"}</option>{reviewers.map(reviewer => <option key={reviewer.wallet} value={reviewer.wallet}>{reviewer.name} · {reviewer.wallet.slice(0, 8)}…{reviewer.wallet.slice(-4)}</option>)}</select><p className="field-help">Reviewer admission is configured separately from ME identity. The invited wallet must accept the funded assignment.</p>{reviewersError && <p className="field-error" role="alert">{reviewersError}</p>}{!reviewersLoading && reviewers.length === 0 && <p className="field-help">No eligible reviewer is currently configured. Ask the workspace operator to configure reviewer admission.</p>}{onRefreshReviewers && <button className="btn ghost small" type="button" disabled={pending || reviewersLoading} onClick={() => void onRefreshReviewers()}><Icon name="refresh" size={12}/>Refresh reviewers</button>}</div>}
        <div className="form-field full-width"><label htmlFor="task-facts">Confirmed facts &amp; brand voice</label><textarea id="task-facts" rows={5} minLength={10} maxLength={2000} required value={form.facts} onChange={e => setForm({ ...form, facts: e.target.value })} placeholder="What is the product? Which features and claims are supported? Who is it for, and how should it sound?" disabled={pending}/><p className="field-help">One fact per line works well. The reviewer’s source of truth. At least 10 characters; {form.facts.length}/2,000 used.</p></div>
      </div>
      <div className="form-section-title">02 / Copy to review</div>
      <div className="form-field"><label htmlFor="task-copy">AI-assisted draft</label><textarea id="task-copy" rows={6} maxLength={6000} required value={form.sourceText} onChange={e => setForm({ ...form, sourceText: e.target.value })} placeholder="Paste the exact English copy you want reviewed…" disabled={pending}/><p className={count > 300 ? "field-error" : "field-help"}>{count}/300 words · The quoted source will be immutable.</p></div>
    </form>
  </Modal>;
}
