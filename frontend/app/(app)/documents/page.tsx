"use client";

import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { PagedDocumentTable } from "@/components/documents/DocumentList";
import { Card, PageHeader } from "@/components/ui";
import { filterableStatuses, statusLabels } from "@/lib/format";
import { useDocumentTypes } from "@/lib/queries";

export default function DocumentsPage() {
  const types = useDocumentTypes();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [typeId, setTypeId] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  return (
    <>
      <PageHeader title="Przegląd dokumentów" description="Dokumenty, do których masz wgląd. To nie są Twoje zadania: te są w „Do zrobienia przeze mnie”." />
      <Card>
        <div className="toolbar">
          <div className="search-input">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              aria-label="Szukaj dokumentów"
              placeholder="Szukaj po tytule, numerze lub kontrahencie"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
            />
          </div>
          <select aria-label="Status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">Wszystkie statusy</option>
            {filterableStatuses.map((value) => <option key={value} value={value}>{statusLabels[value]}</option>)}
          </select>
          <select aria-label="Typ dokumentu" value={typeId} onChange={(event) => setTypeId(event.target.value)}>
            <option value="">Wszystkie typy</option>
            {(types.data ?? []).map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
          </select>
        </div>
        <PagedDocumentTable
          filters={{ search, status, typeId }}
          emptyTitle="Nie znaleziono dokumentów"
          emptyText="Zmień wyszukiwanie lub filtry."
        />
      </Card>
    </>
  );
}
