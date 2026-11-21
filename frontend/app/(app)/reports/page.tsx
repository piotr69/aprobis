"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Badge, Banner, Card, EmptyState, Loading, PageHeader } from "@/components/ui";
import { apiRequest, errorText } from "@/lib/api";
import { date, dueText, fullName, statusLabels } from "@/lib/format";
import { useMe } from "@/lib/queries";
import type { CycleTime, DocumentStatus, DocumentsReport, OverdueTask } from "@/lib/types";

function Bars({ rows }: { rows: Array<{ key: string; label: string; count: number }> }) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <ul className="bars">
      {rows.map((row) => (
        <li key={row.key}>
          <span>{row.label}</span>
          <div className="bar-track" aria-hidden="true"><i style={{ width: `${Math.max(3, (row.count / max) * 100)}%` }} /></div>
          <strong>{row.count}</strong>
        </li>
      ))}
    </ul>
  );
}

function formatHours(hours: number | null) {
  if (hours === null) return "—";
  return hours < 24 ? `${hours.toFixed(1).replace(".", ",")} godz.` : `${(hours / 24).toFixed(1).replace(".", ",")} dni`;
}

export default function ReportsPage() {
  const me = useMe();
  const canSeeDocuments = me.capabilities.viewDocumentReports;
  const report = useQuery({ queryKey: ["report-documents"], queryFn: () => apiRequest<DocumentsReport>("/reports/documents"), enabled: me.capabilities.viewReports });
  const overdue = useQuery({ queryKey: ["report-overdue"], queryFn: () => apiRequest<OverdueTask[]>("/reports/overdue"), enabled: canSeeDocuments });
  const cycles = useQuery({ queryKey: ["report-cycles"], queryFn: () => apiRequest<CycleTime[]>("/reports/cycle-times"), enabled: canSeeDocuments });

  if (!me.capabilities.viewReports) return <Banner tone="danger" title="Brak dostępu">Twoja rola nie ma dostępu do raportów.</Banner>;

  const averageHours = cycles.data?.length
    ? cycles.data.reduce((sum, row) => sum + (row.hours ?? 0), 0) / cycles.data.length
    : null;

  return (
    <>
      <PageHeader title="Raporty" description="Ile dokumentów jest w obiegu i gdzie coś utknęło." />
      {report.isPending && <Loading />}
      {report.error && <Banner tone="danger" title="Nie udało się wczytać raportu">{errorText(report.error)}</Banner>}
      {report.data && (
        <div className="two-columns">
          <Card title="Dokumenty według statusu">
            {report.data.byStatus.length
              ? <Bars rows={report.data.byStatus.map((row) => ({ key: row.status, label: statusLabels[row.status as DocumentStatus] ?? row.status, count: row.count }))} />
              : <EmptyState title="Brak dokumentów" />}
          </Card>
          <Card title="Dokumenty według typu">
            {report.data.byType.length
              ? <Bars rows={report.data.byType.map((row) => ({ key: row.typeId, label: row.type ?? "Nieznany", count: row.count }))} />
              : <EmptyState title="Brak dokumentów" />}
          </Card>
        </div>
      )}

      {canSeeDocuments && (
        <Card title="Zadania po terminie" aside={overdue.data ? <Badge tone={overdue.data.length ? "danger" : "neutral"}>{overdue.data.length}</Badge> : undefined}>
          {overdue.isPending && <Loading />}
          {overdue.error && <Banner tone="danger" title="Nie udało się wczytać zadań po terminie">{errorText(overdue.error)}</Banner>}
          {overdue.data && (overdue.data.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Dokument</th><th>Etap</th><th>U kogo</th><th>Termin</th></tr></thead>
                <tbody>
                  {overdue.data.map((task) => (
                    <tr key={task.id}>
                      <td data-label="Dokument"><Link href={`/documents/${task.document.id}`} className="row-title">{task.document.title}</Link><small className="muted">{task.document.number}</small></td>
                      <td data-label="Etap">{task.name}</td>
                      <td data-label="U kogo">{task.assignedTo ? fullName(task.assignedTo) : "Osoby z roli"}</td>
                      <td data-label="Termin"><span className="text-danger">{dueText(task.dueAt)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <EmptyState title="Nic nie jest po terminie" />)}
        </Card>
      )}

      {canSeeDocuments && (
        <Card title="Czas akceptacji" aside={averageHours !== null ? <span className="muted small">Średnio: {formatHours(averageHours)}</span> : undefined}>
          {cycles.isPending && <Loading />}
          {cycles.error && <Banner tone="danger" title="Nie udało się wczytać czasów akceptacji">{errorText(cycles.error)}</Banner>}
          {cycles.data && (cycles.data.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Dokument</th><th>Typ</th><th>Zakończono</th><th className="num">Czas</th></tr></thead>
                <tbody>
                  {cycles.data.slice(0, 20).map((row) => (
                    <tr key={`${row.documentId}-${row.completedAt}`}>
                      <td data-label="Dokument"><Link href={`/documents/${row.documentId}`} className="row-title">{row.documentTitle}</Link><small className="muted">{row.documentNumber}</small></td>
                      <td data-label="Typ">{row.documentType}</td>
                      <td data-label="Zakończono">{date(row.completedAt)}</td>
                      <td data-label="Czas" className="num">{formatHours(row.hours)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <EmptyState title="Brak zakończonych obiegów" />)}
        </Card>
      )}
    </>
  );
}
