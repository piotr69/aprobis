"use client";

import { Search } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Banner, Card, EmptyState, Loading, PageHeader } from "@/components/ui";
import { apiRequest, errorText } from "@/lib/api";
import { dateTime, fullName } from "@/lib/format";
import { useMe } from "@/lib/queries";
import type { AuditEntry } from "@/lib/types";

const actionText: Record<string, string> = {
  LOGIN: "Logowanie",
  LOGOUT: "Wylogowanie",
  PASSWORD_CHANGED: "Zmiana hasła",
  PASSWORD_RESET: "Nowe hasło przez link",
  UNLOCK: "Odblokowanie konta",
  BOOTSTRAP_ADMIN: "Utworzenie pierwszego administratora",
  CREATE: "Utworzenie",
  UPDATE: "Zmiana",
  UPDATE_WITH_PASSWORD_RESET: "Zmiana z resetem hasła",
  DRAFT_CREATED: "Utworzenie szkicu",
  DRAFT_UPDATED: "Edycja dokumentu",
  WORKFLOW_STARTED: "Złożenie do akceptacji",
  TASK_APPROVED: "Zatwierdzenie etapu",
  TASK_DELEGATED: "Przekazanie zadania",
  TASK_REASSIGNED: "Przepisanie zadania",
  DOCUMENT_APPROVED: "Zatwierdzenie dokumentu",
  DOCUMENT_REJECTED: "Odrzucenie dokumentu",
  DOCUMENT_RETURNED: "Zwrot do poprawy",
  DOCUMENT_CANCELLED: "Wycofanie dokumentu",
  DOCUMENT_ARCHIVED: "Archiwizacja",
  COMMENT_ADDED: "Dodanie komentarza",
  UPLOAD_PENDING_SCAN: "Dodanie pliku",
  FILE_SCAN_CLEAN: "Skan pliku: bezpieczny",
  FILE_SCAN_SKIPPED: "Plik bez skanu (antywirus wyłączony)",
  FILE_SCAN_REJECTED: "Skan pliku: zablokowany",
  FILE_DELETED: "Usunięcie pliku",
  DRAFT_DELETED: "Usunięcie szkicu",
  PUBLISHED: "Publikacja",
  DRAFT_VERSION_CREATED: "Nowa wersja robocza",
  DEACTIVATED: "Wyłączenie",
  CANCELLED: "Odwołanie"
};

const entityText: Record<string, string> = {
  DOCUMENT: "Dokument",
  DOCUMENT_FILE: "Plik",
  DOCUMENT_TYPE: "Typ dokumentu",
  DOCUMENT_TYPE_VERSION: "Wersja typu",
  WORKFLOW_TASK: "Zadanie",
  WORKFLOW_DEFINITION: "Schemat obiegu",
  APPROVAL_RULE: "Reguła",
  USER: "Użytkownik",
  DEPARTMENT: "Dział",
  USER_SUBSTITUTION: "Zastępstwo"
};

export default function AuditPage() {
  const me = useMe();
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setSearch(input.trim()), 300);
    return () => clearTimeout(timer);
  }, [input]);

  const logs = useQuery({
    queryKey: ["audit", search],
    queryFn: () => apiRequest<AuditEntry[]>(`/audit-logs?take=200${search ? `&search=${encodeURIComponent(search)}` : ""}`),
    enabled: me.capabilities.viewAudit
  });

  if (!me.capabilities.viewAudit) return <Banner tone="danger" title="Brak dostępu">Dziennik zdarzeń jest dostępny tylko dla administratora.</Banner>;

  return (
    <>
      <PageHeader title="Dziennik zdarzeń" description="Kto, co i kiedy zrobił w systemie. Pokazujemy ostatnie 200 zdarzeń." />
      <Card>
        <div className="toolbar">
          <div className="search-input">
            <Search size={16} aria-hidden="true" />
            <input type="search" aria-label="Szukaj w dzienniku" placeholder="Szukaj po kodzie zdarzenia lub identyfikatorze" value={input} onChange={(event) => setInput(event.target.value)} />
          </div>
        </div>
        {logs.isPending && <Loading />}
        {logs.error && <Banner tone="danger" title="Nie udało się wczytać dziennika">{errorText(logs.error)}</Banner>}
        {logs.data && !logs.data.length && <EmptyState title="Brak zdarzeń" />}
        {logs.data && logs.data.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Kiedy</th><th>Kto</th><th>Zdarzenie</th><th>Czego dotyczy</th><th>Adres IP</th></tr></thead>
              <tbody>
                {logs.data.map((entry) => (
                  <tr key={entry.id}>
                    <td data-label="Kiedy">{dateTime(entry.createdAt)}</td>
                    <td data-label="Kto">{entry.user ? fullName(entry.user) : "System"}</td>
                    <td data-label="Zdarzenie">{actionText[entry.action] ?? entry.action}</td>
                    <td data-label="Czego dotyczy">
                      {entityText[entry.entityType] ?? entry.entityType}
                      {entry.entityType === "DOCUMENT" && entry.entityId && <small><a href={`/documents/${entry.entityId}`}>Otwórz dokument</a></small>}
                    </td>
                    <td data-label="Adres IP"><span className="muted">{entry.ipAddress ?? "—"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
