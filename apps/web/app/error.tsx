"use client";
export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="error-boundary"><div className="eyebrow coral">HumanDock</div><h1>The desk needs a moment.</h1><p>Something interrupted this view. Your saved work stays with the API. Retry to reload the workspace.</p><button className="btn primary" onClick={reset}>Try again</button></main>;
}
