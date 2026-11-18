import Link from "next/link";
export default function NotFound() {
  return <main className="error-boundary"><div className="eyebrow coral">HumanDock · 404</div><h1>This page isn’t at the dock.</h1><p>Return to the review desk to find your tasks and receipts.</p><Link className="btn primary" href="/">Back to the desk</Link></main>;
}
