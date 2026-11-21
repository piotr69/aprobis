"use client";

import { ArrowLeft, Archive, Check, CornerUpLeft, Pencil, Send, Trash2, UserRoundPlus, X } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { Attachments } from "@/components/documents/Attachments";
import { CancelDialog, DecisionDialog, DeleteDraftDialog, DelegateDialog, ReassignDialog } from "@/components/documents/DocumentDialogs";
import { WorkflowPath } from "@/components/documents/WorkflowPath";
import { Badge, Banner, Card, ErrorBanner, Field, Loading, StatusBadge } from "@/components/ui";
import { useToast } from "@/components/ui/toast";
import { errorText, post } from "@/lib/api";
import { actionLabels, date, dateTime, dueText, fieldValueText, fullName, isOverdue, money, parseData } from "@/lib/format";
import { useDocument, useInvalidateWork, useMe } from "@/lib/queries";
import type { DocumentDetail, DocumentTask, StageTask } from "@/lib/types";

type Decision = "APPROVE" | "RETURN" | "REJECT";

function lastAction(document: DocumentDetail, type: string) {
  return [...document.actions].reverse().find((action) => action.actionType === type);
}

function StatusExplanation({ document }: { document: DocumentDetail }) {
  const allowed = document.actionsAllowed;
  if (document.status === "NEEDS_CORRECTION") {
    const action = lastAction(document, "RETURN");
    return (
      <Banner tone="warning" title={`Zwrócono do poprawy${action?.user ? `: ${fullName(action.user)}` : ""}`}>
        <p>{action?.comment}</p>
        {allowed.canSubmit && <p>Popraw dokument i złóż go ponownie. Obieg zacznie się od początku.</p>}
      </Banner>
    );
  }
  if (document.status === "REJECTED") {
    const action = lastAction(document, "REJECT");
    return <Banner tone="danger" title={`Odrzucono${action?.user ? `: ${fullName(action.user)}` : ""}`}>{action?.comment}</Banner>;
  }
  if (document.status === "CANCELLED") {
    const action = lastAction(document, "CANCEL");
    return <Banner tone="info" title={`Dokument wycofany${action?.user ? `: ${fullName(action.user)}` : ""}`}>{action?.comment}</Banner>;
  }
  if (document.status === "DRAFT" && allowed.canSubmit) {
    return <Banner tone="info" title="To jeszcze szkic">Sprawdź dane i załączniki, a potem złóż dokument do akceptacji. Po prawej widać, kto będzie go akceptować.</Banner>;
  }
  if (document.status === "APPROVED") {
    return <Banner tone="success" title="Dokument zatwierdzony">{allowed.canArchive ? "Można go przenieść do archiwum." : "Wszystkie etapy zostały zakończone."}</Banner>;
  }
  return null;
}

function DecisionCard({ document, onDecide, onDelegate }: { document: DocumentDetail; onDecide: (decision: Decision) => void; onDelegate: () => void }) {
  const task = document.myTask!;
  const rules = task.instanceStage;
  return (
    <section className="decision-card" aria-label="Twoja decyzja">
      <div>
        <h2>Czeka na Twoją decyzję</h2>
        <p>
          Etap: {task.name}
          {task.dueAt && <> · <span className={isOverdue(task.dueAt) ? "text-danger" : ""}>termin: {dueText(task.dueAt)}</span></>}
        </p>
        {task.approvalLimitExceeded && <p className="text-danger">Kwota przekracza Twój limit akceptacji: przekaż zadanie osobie z wyższym limitem albo zwróć dokument.</p>}
      </div>
      <div className="decision-actions">
        <button type="button" className="btn btn-success" disabled={task.approvalLimitExceeded} onClick={() => onDecide("APPROVE")}><Check size={16} />Zatwierdź</button>
        {rules?.canReturn !== false && <button type="button" className="btn" onClick={() => onDecide("RETURN")}><CornerUpLeft size={16} />Zwróć do poprawy</button>}
        <button type="button" className="btn btn-danger-outline" onClick={() => onDecide("REJECT")}><X size={16} />Odrzuć</button>
        {rules?.canDelegate !== false && <button type="button" className="btn btn-ghost" onClick={onDelegate}><UserRoundPlus size={16} />Przekaż</button>}
      </div>
    </section>
  );
}

function Details({ document }: { document: DocumentDetail }) {
  const data = parseData(document.dataJson ?? document.metadataJson);
  return (
    <Card title="Dane dokumentu">
      <dl className="details">
        <div><dt>Numer</dt><dd>{document.number}</dd></div>
        <div><dt>Typ</dt><dd>{document.type.name}</dd></div>
        <div><dt>Autor</dt><dd>{fullName(document.author)}</dd></div>
        <div><dt>Dział</dt><dd>{document.department?.name ?? "—"}</dd></div>
        <div><dt>Utworzono</dt><dd>{date(document.createdAt)}</dd></div>
        {document.submittedAt && <div><dt>Złożono</dt><dd>{date(document.submittedAt)}</dd></div>}
        {document.contractorName && <div><dt>Kontrahent</dt><dd>{document.contractorName}</dd></div>}
        {document.amount !== null && document.amount !== undefined && <div><dt>Kwota</dt><dd>{money(document.amount, document.currency)}</dd></div>}
        {document.formFields.map((field) => (
          <div key={field.key}><dt>{field.label}</dt><dd>{fieldValueText(field, data[field.key])}</dd></div>
        ))}
      </dl>
    </Card>
  );
}

function Comments({ document }: { document: DocumentDetail }) {
  const me = useMe();
  const invalidate = useInvalidateWork();
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const isAuthor = document.author.id === me.id;

  async function add() {
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await post(`/documents/${document.id}/comments`, { body, visibility: internal ? "INTERNAL" : "AUTHOR" });
      setBody("");
      setInternal(false);
      await invalidate();
    } catch (commentError) {
      setError(commentError);
    } finally {
      setBusy(false);
    }
  }

  if (!document.comments.length && !document.actionsAllowed.canComment) return null;

  return (
    <Card title="Komentarze">
      {document.comments.length > 0 && (
        <ul className="comments">
          {document.comments.map((comment) => (
            <li key={comment.id}>
              <div className="comment-head">
                <strong>{fullName(comment.user)}</strong>
                <small className="muted">{dateTime(comment.createdAt)}</small>
                {comment.visibility === "INTERNAL" && <Badge tone="warning">Notatka wewnętrzna</Badge>}
              </div>
              <p>{comment.body}</p>
            </li>
          ))}
        </ul>
      )}
      {document.actionsAllowed.canComment && (
        <div className="stack">
          <ErrorBanner error={error} />
          <Field label="Nowy komentarz">
            <textarea rows={2} value={body} maxLength={4000} onChange={(event) => setBody(event.target.value)} />
          </Field>
          <div className="comment-actions">
            {!isAuthor && (
              <label className="check">
                <input type="checkbox" checked={internal} onChange={(event) => setInternal(event.target.checked)} />
                Notatka wewnętrzna: autor jej nie zobaczy
              </label>
            )}
            <button type="button" className="btn" disabled={busy || !body.trim()} onClick={add}>Dodaj komentarz</button>
          </div>
        </div>
      )}
    </Card>
  );
}

function History({ document }: { document: DocumentDetail }) {
  const actions = document.actions.filter((action) => action.actionType !== "COMMENT");
  return (
    <Card title="Historia">
      {!actions.length && <p className="muted small">Jeszcze nic się nie wydarzyło.</p>}
      <ol className="history">
        {[...actions].reverse().map((action) => (
          <li key={action.id}>
            <strong>{actionLabels[action.actionType] ?? action.actionType}</strong>
            <small className="muted">{fullName(action.user)} · {dateTime(action.createdAt)}</small>
            {action.comment && <p>{action.comment}</p>}
          </li>
        ))}
      </ol>
    </Card>
  );
}

function AdminTools({ document, onReassign }: { document: DocumentDetail; onReassign: (task: StageTask) => void }) {
  const open = document.workflowInstances[0]?.stages.flatMap((stage) => stage.tasks.filter((task) => task.status === "OPEN")) ?? [];
  if (!document.actionsAllowed.canReassign || !open.length) return null;
  return (
    <Card title="Narzędzia administratora">
      <p className="muted small">Jeśli akceptujący jest niedostępny, przepisz zadanie na inną osobę. Administrator nie zatwierdza dokumentów.</p>
      <ul className="admin-tasks">
        {open.map((task) => (
          <li key={task.id}>
            <span>{task.name}</span>
            <button type="button" className="btn btn-sm" onClick={() => onReassign(task)}>Przepisz</button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function DocumentPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const query = useDocument(id);
  const invalidate = useInvalidateWork();
  const [decision, setDecision] = useState<{ type: Decision; task: DocumentTask } | null>(null);
  const [delegating, setDelegating] = useState<DocumentTask | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reassigning, setReassigning] = useState<StageTask | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  if (query.isPending) return <Loading />;
  if (query.error || !query.data) {
    return (
      <>
        <Banner tone="danger" title="Nie udało się otworzyć dokumentu">{errorText(query.error)}</Banner>
        <Link href="/documents" className="btn"><ArrowLeft size={16} />Wróć do listy</Link>
      </>
    );
  }
  const document = query.data;
  const allowed = document.actionsAllowed;

  async function submit() {
    setBusy(true);
    setActionError(null);
    try {
      await post(`/documents/${id}/submit`);
      await invalidate();
      toast.success("Dokument złożony do akceptacji");
    } catch (submitError) {
      setActionError(submitError);
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    setBusy(true);
    setActionError(null);
    try {
      await post(`/documents/${id}/archive`, { expectedVersion: document.version });
      await invalidate();
      toast.success("Dokument przeniesiono do archiwum");
    } catch (archiveError) {
      setActionError(archiveError);
    } finally {
      setBusy(false);
    }
  }

  const decisionMessage: Record<Decision, string> = {
    APPROVE: "Zatwierdzono",
    RETURN: "Zwrócono do poprawy",
    REJECT: "Odrzucono dokument"
  };

  return (
    <>
      <button type="button" className="back-link" onClick={() => router.back()}><ArrowLeft size={16} />Wróć</button>
      <header className="page-head">
        <div>
          <div className="title-line">
            <h1>{document.title}</h1>
            <StatusBadge status={document.status} />
          </div>
          <p>{document.number} · {document.type.name}</p>
        </div>
        <div className="page-actions">
          {/* Szkic, który nigdy nie był w obiegu, się usuwa; po wysłaniu zostaje już tylko wycofanie. */}
          {allowed.canDelete
            ? <button type="button" className="btn btn-ghost" onClick={() => setDeleting(true)}><Trash2 size={16} />Usuń szkic</button>
            : allowed.canCancel && <button type="button" className="btn btn-ghost" onClick={() => setCancelling(true)}>Wycofaj</button>}
          {allowed.canEdit && <Link href={`/documents/${id}/edit`} className="btn"><Pencil size={16} />Edytuj</Link>}
          {allowed.canSubmit && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>
              <Send size={16} />{busy ? "Składanie…" : document.status === "NEEDS_CORRECTION" ? "Złóż ponownie" : "Złóż do akceptacji"}
            </button>
          )}
          {allowed.canArchive && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={archive}><Archive size={16} />Do archiwum</button>
          )}
        </div>
      </header>

      <ErrorBanner error={actionError} />
      <StatusExplanation document={document} />
      {document.myTask && (
        <DecisionCard
          document={document}
          onDecide={(type) => setDecision({ type, task: document.myTask! })}
          onDelegate={() => setDelegating(document.myTask!)}
        />
      )}

      <div className="detail-layout">
        <div className="detail-main">
          <Details document={document} />
          <Attachments document={document} />
          <Comments document={document} />
        </div>
        <div className="detail-side">
          <WorkflowPath document={document} />
          <AdminTools document={document} onReassign={setReassigning} />
          <History document={document} />
        </div>
      </div>

      {decision && (
        <DecisionDialog
          document={document}
          task={decision.task}
          decision={decision.type}
          onClose={() => setDecision(null)}
          onDone={(done) => { setDecision(null); toast.success(decisionMessage[done]); }}
        />
      )}
      {delegating && <DelegateDialog document={document} task={delegating} onClose={() => setDelegating(null)} onDone={() => { setDelegating(null); toast.success("Zadanie przekazano"); }} />}
      {cancelling && <CancelDialog document={document} onClose={() => setCancelling(false)} onDone={() => { setCancelling(false); toast.success("Dokument wycofano"); }} />}
      {deleting && (
        <DeleteDraftDialog
          document={document}
          onClose={() => setDeleting(false)}
          onDone={() => {
            // Najpierw opuść stronę, inaczej odświeżenie danych pokaże błąd „nie znaleziono”.
            router.replace("/my-documents");
            void invalidate();
            toast.success("Szkic usunięto");
          }}
        />
      )}
      {reassigning && <ReassignDialog document={document} task={reassigning} onClose={() => setReassigning(null)} onDone={() => { setReassigning(null); toast.success("Zadanie przepisano"); }} />}
    </>
  );
}
