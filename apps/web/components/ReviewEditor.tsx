"use client";
import { useState, type FormEvent } from "react";
import { CRITERIA, type Check, type ReportInput, type Task, type Verdict } from "@/lib/types";
import { errorMessage } from "@/lib/api";
import { wordCount } from "@/lib/format";
import Icon from "./Icon";

export type AiResult = { suggestions: Check[]; mode: "rules" | "provider" };
export default function ReviewEditor({ task, disabled, aiMode, onAiChecks, onSubmit }: { task: Task; disabled: boolean; aiMode: "rules" | "provider"; onAiChecks: () => Promise<AiResult>; onSubmit: (input: ReportInput) => Promise<void> }) {
  const [reviewedText, setReviewedText] = useState(task.sourceText);
  const [summary, setSummary] = useState("");
  const [verdict, setVerdict] = useState<Verdict>("CHANGES_REQUIRED");
  const [checks, setChecks] = useState<Check[]>(CRITERIA.map(({ key }) => ({ criterion: key, result: "UNKNOWN", comment: "", evidenceRefs: [] })));
  const [aiPending, setAiPending] = useState(false);
  const [aiNotice, setAiNotice] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const pending = disabled || aiPending || submitting;
  const valid = reviewedText.trim() && wordCount(reviewedText) <= 300 && summary.trim().length >= 10 && checks.every(c => c.comment.trim()) && (verdict !== "PASS" || checks.every(c => c.result === "OK"));
  function update(index: number, patch: Partial<Check>) { setChecks(current => current.map((check, i) => i === index ? { ...check, ...patch } : check)); }
  async function runChecks() {
    setAiPending(true); setError("");
    try {
      const result = await onAiChecks();
      setChecks(current => current.map(check => {
        const suggestion = result.suggestions.find(item => item.criterion === check.criterion);
        return suggestion && !check.comment.trim() ? { ...check, result: suggestion.result, comment: suggestion.comment, evidenceRefs: suggestion.evidenceRefs || [] } : check;
      }));
      setAiNotice(result.mode === "rules" ? "Local rule checks added to empty fields. No live AI model was called. You must inspect and complete every criterion." : "AI suggestions added to empty fields. They are drafts; you make the final review decision.");
    } catch (err) { setError(errorMessage(err)); }
    finally { setAiPending(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!valid || pending) return;
    setSubmitting(true); setError("");
    try { await onSubmit({ reviewedText: reviewedText.trim(), summary: summary.trim(), verdict, checks }); }
    catch (err) { setError(errorMessage(err)); }
    finally { setSubmitting(false); }
  }
  return <form className="review-form" onSubmit={submit}>
    <div className="review-tools full-width"><button className="btn small" type="button" disabled={pending} onClick={runChecks}>{aiPending ? <span className="spinner"/> : <Icon name="spark" size={12}/>} {aiMode === "rules" ? "Run rule checks" : "Get AI suggestions"}</button><p>{aiMode === "rules" ? "Local rules · no model" : "AI-assisted · human decision"}</p></div>
    {aiNotice && <div className="subtle-callout full-width" role="status">{aiNotice}</div>}
    {error && <div className="form-error-inline full-width" role="alert">{error}</div>}
    <div className="full-width"><label htmlFor="review-copy">Reviewed copy</label><textarea id="review-copy" rows={5} maxLength={6000} value={reviewedText} onChange={e => setReviewedText(e.target.value)} disabled={pending} required/><p className={wordCount(reviewedText) > 300 ? "field-error" : "field-help"}>{wordCount(reviewedText)}/300 words · This exact version will be reviewed.</p></div>
    <div className="full-width"><label>Five review criteria</label><div className="check-list">{CRITERIA.map((criterion, index) => <details className="check-card" key={criterion.key}>
      <summary>{criterion.title}<span className={`badge ${checks[index].result === "OK" ? "green" : checks[index].result === "ISSUE" ? "coral" : "neutral"}`}>{checks[index].result}</span></summary>
      <div className="check-body"><p>{criterion.help}</p><select aria-label={`${criterion.title} result`} value={checks[index].result} onChange={e => update(index, { result: e.target.value as Check["result"] })} disabled={pending}><option value="UNKNOWN">Unknown / needs human judgment</option><option value="OK">OK</option><option value="ISSUE">Issue found</option></select><textarea aria-label={`${criterion.title} reasoning`} placeholder="Explain your assessment…" value={checks[index].comment} onChange={e => update(index, { comment: e.target.value })} disabled={pending} maxLength={1500}/><input aria-label={`${criterion.title} evidence references`} placeholder="Evidence reference, e.g. brief line 2" value={checks[index].evidenceRefs.join(", ")} onChange={e => update(index, { evidenceRefs: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })} disabled={pending}/></div>
    </details>)}</div></div>
    <div className="full-width"><label htmlFor="review-summary">Human review summary</label><textarea id="review-summary" rows={3} placeholder="What did you change, and why?" value={summary} onChange={e => setSummary(e.target.value)} required minLength={10} maxLength={2000} disabled={pending}/><p className="field-help">At least 10 characters. Explain your human assessment.</p></div>
    <div className="full-width"><label htmlFor="review-verdict">Verdict for the reviewed version</label><select id="review-verdict" value={verdict} onChange={e => setVerdict(e.target.value as Verdict)} disabled={pending}><option value="CHANGES_REQUIRED">Changes required</option><option value="PASS">Pass · all five checks must be OK</option><option value="BLOCK">Block · do not approve this version</option></select>{verdict === "PASS" && !checks.every(c => c.result === "OK") && <p className="field-error">PASS requires all five criteria to be OK. Resolve each check first.</p>}</div>
    <div className="full-width"><button className="btn navy full" type="submit" disabled={!valid || pending}>{submitting ? <span className="spinner"/> : <Icon name="check" size={13}/>}Submit human review</button><p className="field-help">The report becomes immutable. A BLOCK or CHANGES REQUIRED verdict may still be a completed, payable service.</p></div>
  </form>;
}
