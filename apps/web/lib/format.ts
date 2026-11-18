import type { Task } from "./types";
export function formatAtoms(value: string | undefined): string {
  if (!value || !/^-?\d+$/.test(value)) return "0";
  const signed = BigInt(value);
  const sign = signed < 0n ? "−" : "";
  const amount = signed < 0n ? -signed : signed;
  const base = 10n ** 18n;
  const whole = (amount / base).toString();
  const decimal = (amount % base).toString().padStart(18, "0").replace(/0+$/, "");
  return sign + (decimal ? `${whole}.${decimal}` : whole);
}
export function shortId(value: string | undefined | null, length = 8): string {
  if (!value) return "—";
  return value.length > length * 2 + 3 ? `${value.slice(0, length)}…${value.slice(-5)}` : value;
}
export function formatDate(value: string | null | undefined, includeTime = false): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", ...(includeTime ? { hour: "numeric", minute: "2-digit" } : {}) });
}
export function taskLabel(task: Task): string {
  if (task.status === "DRAFT") return task.quote ? "Quote ready" : "Draft";
  return { FUNDED: "Awaiting reviewer", ASSIGNED: "In review", SUBMITTED: "Review delivered", DISPUTED: "In dispute", CLOSED: "Closed" }[task.status];
}
export function wordCount(text: string): number { return text.trim() ? text.trim().split(/\s+/).length : 0; }
export function apiDownloadUrl(path: string): string {
  if (path.startsWith("/api/v1/")) return path;
  if (path.startsWith("/v1/")) return `/api${path}`;
  // Only the local API may provide private artifacts. Never forward session data to external hosts.
  throw new Error("The API returned an unsupported artifact address.");
}
