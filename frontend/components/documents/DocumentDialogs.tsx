"use client";

import { useState } from "react";
import { ErrorBanner, Field, Modal } from "@/components/ui";
import { post, remove } from "@/lib/api";
import { fullName } from "@/lib/format";
import { useInvalidateWork, useMe, useRoles, useUsers } from "@/lib/queries";
import type { DocumentDetail, DocumentTask, StageTask } from "@/lib/types";

type Decision = "APPROVE" | "RETURN" | "REJECT";

const decisionCopy: Record<Decision, { title: string; confirm: string; className: string; label: string; hint: string }> = {
  APPROVE: { title: "Zatwierdź dokument", confirm: "Zatwierdź", className: "btn-success", label: "Komentarz", hint: "Komentarz zobaczy autor dokumentu." },
  RETURN: { title: "Zwróć do poprawy", confirm: "Zwróć do poprawy", className: "btn-primary", label: "Co trzeba poprawić?", hint: "Autor zobaczy ten opis. Po poprawkach obieg zacznie się od początku." },
  REJECT: { title: "Odrzuć dokument", confirm: "Odrzuć", className: "btn-danger", label: "Powód odrzucenia", hint: "Autor zobaczy ten powód. Odrzucenie kończy obieg i nie można go cofnąć." }
};

/**
 * Okna działają na zadaniu z chwili otwarcia. Dane w tle odświeżają się, więc po decyzji
 * kogoś innego `document.myTask` znika, a użytkownik ma zobaczyć komunikat o konflikcie.
 */
export function DecisionDialog({ document, task, decision, onClose, onDone }: { document: DocumentDetail; task: DocumentTask; decision: Decision; onClose: () => void; onDone: (decision: Decision) => void }) {
  const invalidate = useInvalidateWork();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const copy = decisionCopy[decision];
  const required = decision !== "APPROVE" || Boolean(task.instanceStage?.requiresComment);

  async function submit() {
    if (required && !comment.trim()) {
      setError(new Error("To pole jest wymagane"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post(`/workflow/tasks/${task.id}/decision`, { decision, comment: comment.trim() || undefined, expectedVersion: task.version });
      await invalidate();
      onDone(decision);
    } catch (decisionError) {
      await invalidate();
      setError(decisionError);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={copy.title}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Anuluj</button>
          <button type="button" className={`btn ${copy.className}`} onClick={submit} disabled={busy}>{busy ? "Zapisywanie…" : copy.confirm}</button>
        </>
      )}
    >
      <div className="stack">
        <p className="muted">{document.number}: {document.title}</p>
        <ErrorBanner error={error} />
        <Field label={copy.label} required={required} hint={copy.hint}>
          <textarea rows={4} value={comment} maxLength={4000} onChange={(event) => setComment(event.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/**
 * Wybór osoby z katalogu: bez autora dokumentu, bo nie może on decydować o własnym dokumencie,
 * i tylko z rolą, która może decydować w obiegu (backend odmówi administratorowi, audytorowi i podglądowi).
 */
function PersonSelect({ value, onChange, excludeIds }: { value: string; onChange: (value: string) => void; excludeIds: string[] }) {
  const users = useUsers();
  const roles = useRoles();
  const deciding = new Set((roles.data ?? []).filter((role) => role.decideTasks).map((role) => role.role));
  const options = (users.data ?? []).filter((user) => user.isActive && deciding.has(user.role) && !excludeIds.includes(user.id));
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">Wybierz osobę…</option>
      {options.map((user) => (
        <option key={user.id} value={user.id}>{fullName(user)}{user.department ? ` · ${user.department.name}` : ""}</option>
      ))}
    </select>
  );
}

export function DelegateDialog({ document, task, onClose, onDone }: { document: DocumentDetail; task: DocumentTask; onClose: () => void; onDone: () => void }) {
  const me = useMe();
  const invalidate = useInvalidateWork();
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit() {
    if (!target) {
      setError(new Error("Wybierz osobę"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post(`/workflow/tasks/${task.id}/delegate`, { delegateToUserId: target, expectedVersion: task.version });
      await invalidate();
      onDone();
    } catch (delegateError) {
      setError(delegateError);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Przekaż zadanie"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Anuluj</button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? "Zapisywanie…" : "Przekaż"}</button>
        </>
      )}
    >
      <div className="stack">
        <ErrorBanner error={error} />
        <Field label="Komu przekazać?" required hint="Ta osoba przejmie decyzję i dostanie powiadomienie.">
          <PersonSelect value={target} onChange={setTarget} excludeIds={[document.author.id, me.id]} />
        </Field>
      </div>
    </Modal>
  );
}

export function ReassignDialog({ document, task, onClose, onDone }: { document: DocumentDetail; task: StageTask; onClose: () => void; onDone: () => void }) {
  const invalidate = useInvalidateWork();
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await post(`/workflow/tasks/${task.id}/reassign`, { assignToUserId: target, comment: reason, expectedVersion: task.version });
      await invalidate();
      onDone();
    } catch (reassignError) {
      setError(reassignError);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Przepisz zadanie: ${task.name}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Anuluj</button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || !target || reason.trim().length < 3}>{busy ? "Zapisywanie…" : "Przepisz"}</button>
        </>
      )}
    >
      <div className="stack">
        <ErrorBanner error={error} />
        <Field label="Nowa osoba" required>
          <PersonSelect value={target} onChange={setTarget} excludeIds={[document.author.id]} />
        </Field>
        <Field label="Powód" required hint="Na przykład: pracownik na zwolnieniu. Zapisze się w historii dokumentu.">
          <input value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

export function CancelDialog({ document, onClose, onDone }: { document: DocumentDetail; onClose: () => void; onDone: () => void }) {
  const invalidate = useInvalidateWork();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await post(`/documents/${document.id}/cancel`, { expectedVersion: document.version, reason: reason.trim() || undefined });
      await invalidate();
      onDone();
    } catch (cancelError) {
      setError(cancelError);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Wycofać dokument?"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Nie wycofuj</button>
          <button type="button" className="btn btn-danger" onClick={submit} disabled={busy}>{busy ? "Zapisywanie…" : "Wycofaj dokument"}</button>
        </>
      )}
    >
      <div className="stack">
        <p>Obieg zostanie zatrzymany, a otwarte zadania znikną. Tego nie można cofnąć.</p>
        <ErrorBanner error={error} />
        <Field label="Powód (opcjonalnie)">
          <input value={reason} maxLength={1000} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/** Trwałe usunięcie szkicu, który nigdy nie był w obiegu. Dokument po wysłaniu się wycofuje. */
export function DeleteDraftDialog({ document, onClose, onDone }: { document: DocumentDetail; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await remove(`/documents/${document.id}?expectedVersion=${document.version}`);
      onDone();
    } catch (deleteError) {
      setError(deleteError);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Usunąć szkic?"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Nie usuwaj</button>
          <button type="button" className="btn btn-danger" onClick={submit} disabled={busy}>{busy ? "Usuwanie…" : "Usuń szkic"}</button>
        </>
      )}
    >
      <div className="stack">
        <p>Szkic {document.number} zniknie razem z załącznikami. Tego nie można cofnąć.</p>
        <ErrorBanner error={error} />
      </div>
    </Modal>
  );
}
