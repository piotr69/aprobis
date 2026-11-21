"use client";

import { Paperclip } from "lucide-react";
import Link from "next/link";
import { EmptyState, Loading, StatusBadge, Banner } from "@/components/ui";
import { errorText } from "@/lib/api";
import { date, dueText, fullName, isOverdue, money } from "@/lib/format";
import type { DocumentFilters } from "@/lib/queries";
import { useDocuments } from "@/lib/queries";
import type { DocumentListItem } from "@/lib/types";

/** Kto ma teraz piłkę: najważniejsza informacja o dokumencie w toku. */
export function currentHolder(document: DocumentListItem) {
  if (document.status === "NEEDS_CORRECTION") return fullName(document.author);
  const task = document.tasks[0];
  if (!task) return null;
  const people = [...new Set(document.tasks.map((item) => item.assignedTo ? fullName(item.assignedTo) : null).filter(Boolean))];
  return people.length ? people.join(", ") : "Osoby z wyznaczonej roli";
}

export function DocumentTable({ documents }: { documents: DocumentListItem[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Dokument</th>
            <th>Status</th>
            <th>Teraz u</th>
            <th>Autor</th>
            <th className="num">Kwota</th>
            <th>Zmieniono</th>
          </tr>
        </thead>
        <tbody>
          {documents.map((document) => {
            const holder = currentHolder(document);
            const due = document.tasks[0]?.dueAt;
            return (
              <tr key={document.id}>
                <td data-label="Dokument">
                  <Link href={`/documents/${document.id}`} className="row-title">{document.title}</Link>
                  <small className="muted">
                    {document.number} · {document.type.name}
                    {document._count.files > 0 && <span className="inline-icon"><Paperclip size={12} aria-label="Załączniki" />{document._count.files}</span>}
                  </small>
                </td>
                <td data-label="Status"><StatusBadge status={document.status} /></td>
                <td data-label="Teraz u">
                  {holder ?? <span className="muted">—</span>}
                  {document.status === "IN_APPROVAL" && due && <small className={isOverdue(due) ? "text-danger" : "muted"}>{dueText(due)}</small>}
                </td>
                <td data-label="Autor">{fullName(document.author)}</td>
                <td data-label="Kwota" className="num">{document.amount ? money(document.amount, document.currency) : <span className="muted">—</span>}</td>
                <td data-label="Zmieniono">{date(document.updatedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function PagedDocumentTable({ filters, emptyTitle, emptyText, emptyAction }: {
  filters: DocumentFilters;
  emptyTitle: string;
  emptyText?: string;
  emptyAction?: React.ReactNode;
}) {
  const query = useDocuments(filters);
  if (query.isPending) return <Loading />;
  if (query.error) return <Banner tone="danger" title="Nie udało się wczytać dokumentów">{errorText(query.error)}</Banner>;
  if (!query.items.length) return <EmptyState title={emptyTitle} action={emptyAction}>{emptyText}</EmptyState>;
  return (
    <>
      <DocumentTable documents={query.items} />
      {query.hasNextPage && (
        <div className="load-more">
          <button type="button" className="btn" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
            {query.isFetchingNextPage ? "Wczytywanie…" : "Pokaż więcej"}
          </button>
        </div>
      )}
    </>
  );
}
