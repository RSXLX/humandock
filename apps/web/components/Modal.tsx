"use client";
import { useEffect, useId, useRef } from "react";
import Icon from "./Icon";

export default function Modal({ title, subtitle, onClose, busy = false, children, footer }: { title: string; subtitle?: string; onClose: () => void; busy?: boolean; children: React.ReactNode; footer?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const busyRef = useRef(busy); busyRef.current = busy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>("input, textarea, select, button")?.focus());
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busyRef.current) { event.preventDefault(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const elements = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') || []);
      const first = elements[0], last = elements[elements.length - 1];
      if (!first) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", keydown);
    return () => { cancelAnimationFrame(frame); document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop"><div className="modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId}>
    <header className="modal-header"><div><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-btn" onClick={onClose} aria-label="Close dialog" disabled={busy}><Icon name="close" size={19}/></button></header>
    <div className="modal-content">{children}</div>
    {footer && <footer className="modal-footer">{footer}</footer>}
  </div></div>;
}
