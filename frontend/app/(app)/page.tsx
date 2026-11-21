"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, Banner, Card, EmptyState, Loading, PageHeader } from "@/components/ui";
import { errorText } from "@/lib/api";
import { date, dueText, fullName, isOverdue, money } from "@/lib/format";
import { useDocuments, useMe, useMyTasks } from "@/lib/queries";

const PAGE_SIZE = 25;

function MoreButton({ query }: { query: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown } }) {
  if (!query.hasNextPage) return null;
  return (
    <div className="load-more">
      <button type="button" className="btn" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
        {query.isFetchingNextPage ? "Wczytywanie…" : "Pokaż więcej"}
      </button>
    </div>
  );
}

function SectionError({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => unknown }): ReactNode {
  return (
    <Banner tone="danger" title={title}>
      <p>{errorText(error)}</p>
      <button type="button" className="btn btn-sm" onClick={() => onRetry()}>Spróbuj ponownie</button>
    </Banner>
  );
}

/**
 * Główny ekran: tylko to, co użytkownik sam ma teraz zrobić. Każdy wiersz mówi, jaka to
 * czynność, i ma jeden przycisk. Zadania innych osób tu nie trafiają, nawet jeśli rola
 * pozwala oglądać ich dokumenty: wgląd to nie to samo co przydział pracy.
 */
export default function TodoPage() {
  const me = useMe();
  const tasks = useMyTasks();
  const corrections = useDocuments({ scope: "created-by-me", status: "NEEDS_CORRECTION" }, PAGE_SIZE);
  const drafts = useDocuments({ scope: "created-by-me", status: "DRAFT" }, PAGE_SIZE);
  const toArchive = useDocuments({ status: "APPROVED" }, 1);

  const taskItems = tasks.data ?? [];
  const archiveCount = me.capabilities.archiveDocuments ? toArchive.total : 0;
  const total = taskItems.length + corrections.total + drafts.total;
  const pending = tasks.isPending || corrections.isPending || drafts.isPending;
  const failed = Boolean(tasks.error || corrections.error || drafts.error);

  return (
    <>
      <PageHeader
        title="Do zrobienia przeze mnie"
        description={total ? `${me.firstName}, tyle spraw czeka na Twój ruch: ${total}. Najpilniejsze są na górze.` : `${me.firstName}, tu pojawi się wszystko, co wymaga Twojego działania.`}
      />

      {me.actingFor.length > 0 && (
        <Banner tone="info" title="Masz aktywne zastępstwo">
          Zastępujesz: {me.actingFor.map((person) => `${fullName(person)} (do ${date(person.validTo)})`).join(", ")}. Ich zadania są na Twojej liście.
        </Banner>
      )}
      {tasks.error && <SectionError title="Nie udało się wczytać Twoich zadań" error={tasks.error} onRetry={tasks.refetch} />}
      {corrections.error && <SectionError title="Nie udało się wczytać dokumentów do poprawy" error={corrections.error} onRetry={corrections.refetch} />}
      {drafts.error && <SectionError title="Nie udało się wczytać szkiców" error={drafts.error} onRetry={drafts.refetch} />}
      {pending && <Loading />}

      {/* „Nic do zrobienia” tylko wtedy, gdy na pewno wiadomo to ze wszystkich źródeł. */}
      {!pending && !failed && total === 0 && !archiveCount && (
        <Card>
          <EmptyState title="Nie masz nic do zrobienia">Gdy ktoś przekaże Ci dokument do decyzji albo zwróci Twój do poprawy, zobaczysz to tutaj.</EmptyState>
        </Card>
      )}

      {taskItems.length > 0 && (
        <Card title={`Czekają na Twoją decyzję (${taskItems.length})`}>
          <div className="work-section">
            {taskItems.map((task) => (
              <div key={task.id} className="work-row">
                <div className="work-main">
                  <span className="work-action">{task.approvalLimitExceeded ? `Ponad Twój limit, przekaż dalej: ${task.name}` : `Zdecyduj: ${task.name}`}</span>
                  <Link href={`/documents/${task.documentId}`} className="row-title">{task.document.title}</Link>
                  <small className="muted">
                    {task.document.number} · {task.document.type.name} · od {fullName(task.document.author)}
                    {task.document.amount ? ` · ${money(task.document.amount, task.document.currency)}` : ""}
                  </small>
                </div>
                <div className="work-side">
                  <Badge tone={isOverdue(task.dueAt) ? "danger" : "neutral"}>{dueText(task.dueAt)}</Badge>
                  <Link href={`/documents/${task.documentId}`} className="btn btn-primary btn-sm">Sprawdź i zdecyduj</Link>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {corrections.items.length > 0 && (
        <Card title={`Zwrócone Ci do poprawy (${corrections.total})`}>
          <div className="work-section">
            {corrections.items.map((document) => (
              <div key={document.id} className="work-row">
                <div className="work-main">
                  <span className="work-action work-action-warning">Popraw i złóż ponownie</span>
                  <Link href={`/documents/${document.id}`} className="row-title">{document.title}</Link>
                  <small className="muted">{document.number} · {document.type.name}</small>
                </div>
                <div className="work-side">
                  <Link href={`/documents/${document.id}`} className="btn btn-primary btn-sm">Popraw dokument</Link>
                </div>
              </div>
            ))}
          </div>
          <MoreButton query={corrections} />
        </Card>
      )}

      {drafts.items.length > 0 && (
        <Card title={`Twoje niedokończone szkice (${drafts.total})`}>
          <div className="work-section">
            {drafts.items.map((document) => (
              <div key={document.id} className="work-row">
                <div className="work-main">
                  <span className="work-action work-action-neutral">Dokończ i złóż do akceptacji</span>
                  <Link href={`/documents/${document.id}`} className="row-title">{document.title}</Link>
                  <small className="muted">{document.number} · {document.type.name} · utworzono {date(document.createdAt)}</small>
                </div>
                <div className="work-side">
                  <Link href={`/documents/${document.id}`} className="btn btn-sm">Dokończ</Link>
                </div>
              </div>
            ))}
          </div>
          <MoreButton query={drafts} />
        </Card>
      )}

      {archiveCount > 0 && (
        <Card title={`Do archiwizacji (${archiveCount})`}>
          <div className="work-row">
            <div className="work-main">
              <span className="work-action work-action-neutral">Przenieś do archiwum</span>
              <span>Zatwierdzone dokumenty czekają na przeniesienie do archiwum.</span>
            </div>
            <div className="work-side">
              <Link href="/archive" className="btn btn-sm">Przejdź do listy</Link>
            </div>
          </div>
        </Card>
      )}
    </>
  );
}
