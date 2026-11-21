"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { ApiError } from "@/lib/api";
import { statusLabels, statusTones } from "@/lib/format";
import type { DocumentStatus } from "@/lib/types";

export function StatusBadge({ status }: { status: DocumentStatus }) {
  return <span className={`badge badge-${statusTones[status] ?? "neutral"}`}>{statusLabels[status] ?? status}</span>;
}

export function Badge({ tone = "neutral", children }: { tone?: string; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Card({ title, aside, children, className = "" }: { title?: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || aside) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {aside && <div className="card-aside">{aside}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Loading({ label = "Wczytywanie…" }: { label?: string }) {
  return <p className="loading" role="status">{label}</p>;
}

export function Banner({ tone = "info", title, children }: { tone?: "info" | "warning" | "danger" | "success"; title?: string; children?: ReactNode }) {
  return (
    <div className={`banner banner-${tone}`} role={tone === "danger" ? "alert" : "status"}>
      {title && <strong>{title}</strong>}
      {children && <div>{children}</div>}
    </div>
  );
}

/** Błąd API w formularzu: główny komunikat i lista konkretnych pól do poprawy. */
export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : "Nie udało się wykonać operacji";
  const issues = error instanceof ApiError ? error.issues : [];
  return (
    <Banner tone="danger" title={message}>
      {issues.length > 0 && (
        <ul>
          {[...new Set(issues.map((issue) => issue.message))].map((text) => <li key={text}>{text}</li>)}
        </ul>
      )}
    </Banner>
  );
}

export function Field({ label, hint, required, children, wide }: { label: string; hint?: string; required?: boolean; children: ReactNode; wide?: boolean }) {
  return (
    <label className={wide ? "field field-wide" : "field"}>
      <span className="field-label">
        {label}
        {required && <span className="field-required" aria-label="wymagane"> *</span>}
      </span>
      {children}
      {hint && <small className="field-hint">{hint}</small>}
    </label>
  );
}

export function Modal({ title, onClose, children, footer, size = "md" }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: "md" | "lg" }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = dialogRef.current?.querySelector<HTMLElement>("textarea, input, select, button:not(.modal-close)");
    (focusable ?? dialogRef.current)?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
    // Fokus ustawiamy tylko przy otwarciu: onClose bywa nową funkcją przy każdym renderze.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`modal modal-${size}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef} tabIndex={-1}>
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn modal-close" aria-label="Zamknij" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, options }: { value: T; onChange: (value: T) => void; options: Array<{ value: T; label: string }> }) {
  return (
    <div className="tabs" role="tablist">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          className={value === option.value ? "tab is-active" : "tab"}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
