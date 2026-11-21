"use client";

import { Search } from "lucide-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Badge, Banner, Card, EmptyState, Loading, PageHeader } from "@/components/ui";
import { apiRequest, errorText } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { useMe } from "@/lib/queries";
import type { SystemLogEntry, SystemLogPage } from "@/lib/types";

const levelLabel: Record<SystemLogEntry["level"], { text: string; tone: string }> = {
  error: { text: "Błąd", tone: "danger" },
  warn: { text: "Ostrzeżenie", tone: "warning" },
  info: { text: "Informacja", tone: "info" },
  debug: { text: "Diagnostyka", tone: "neutral" }
};

const sourceLabel: Record<string, string> = { api: "Serwer", worker: "Praca w tle" };

const levelFilters = [
  { value: "", label: "Wszystkie poziomy" },
  { value: "error", label: "Tylko błędy" },
  { value: "warn,error", label: "Błędy i ostrzeżenia" },
  { value: "info", label: "Informacje" }
];

function prettyContext(json: string | null) {
  if (!json) return null;
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

export default function SystemLogsPage() {
  const me = useMe();
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState("warn,error");
  const [source, setSource] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setSearch(input.trim()), 300);
    return () => clearTimeout(timer);
  }, [input]);

  const logs = useInfiniteQuery({
    queryKey: ["system-logs", level, source, search],
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ take: "100" });
      if (level) params.set("level", level);
      if (source) params.set("source", source);
      if (search) params.set("search", search);
      if (pageParam) params.set("cursor", pageParam);
      return apiRequest<SystemLogPage>(`/system-logs?${params}`);
    },
    getNextPageParam: (last) => (last.hasMore ? last.items[last.items.length - 1]?.id : undefined),
    enabled: me.capabilities.viewSystemLogs
  });

  if (!me.capabilities.viewSystemLogs) return <Banner tone="danger" title="Brak dostępu">Logi systemowe są dostępne tylko dla administratora.</Banner>;

  const items = logs.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      <PageHeader
        title="Logi systemowe"
        description="Błędy, ostrzeżenia i praca programu w tle. Wpisy starsze niż 90 dni są usuwane automatycznie. Działania ludzi są w dzienniku zdarzeń."
      />
      <Card>
        <div className="toolbar">
          <div className="search-input">
            <Search size={16} aria-hidden="true" />
            <input type="search" aria-label="Szukaj w logach" placeholder="Szukaj w treści, np. login albo identyfikator" value={input} onChange={(event) => setInput(event.target.value)} />
          </div>
          <select aria-label="Poziom" value={level} onChange={(event) => setLevel(event.target.value)}>
            {levelFilters.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <select aria-label="Źródło" value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="">Serwer i praca w tle</option>
            <option value="api">Serwer</option>
            <option value="worker">Praca w tle</option>
          </select>
        </div>
        {logs.isPending && <Loading />}
        {logs.error && <Banner tone="danger" title="Nie udało się wczytać logów">{errorText(logs.error)}</Banner>}
        {logs.data && !items.length && <EmptyState title="Brak wpisów">Zmień filtry, aby zobaczyć więcej.</EmptyState>}
        {items.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Kiedy</th><th>Poziom</th><th>Źródło</th><th>Treść</th></tr></thead>
              <tbody>
                {items.map((entry) => {
                  const context = prettyContext(entry.contextJson);
                  const label = levelLabel[entry.level] ?? { text: entry.level, tone: "neutral" };
                  return (
                    <tr key={entry.id}>
                      <td data-label="Kiedy">{dateTime(entry.createdAt)}</td>
                      <td data-label="Poziom"><Badge tone={label.tone}>{label.text}</Badge></td>
                      <td data-label="Źródło">{sourceLabel[entry.source] ?? entry.source}</td>
                      <td data-label="Treść">
                        {entry.message}
                        {context && (
                          <details>
                            <summary className="muted">Szczegóły</summary>
                            <pre className="log-context">{context}</pre>
                          </details>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {logs.hasNextPage && (
          <button type="button" className="btn" onClick={() => logs.fetchNextPage()} disabled={logs.isFetchingNextPage}>
            {logs.isFetchingNextPage ? "Wczytywanie…" : "Pokaż starsze"}
          </button>
        )}
      </Card>
    </>
  );
}
