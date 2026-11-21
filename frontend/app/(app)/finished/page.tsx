"use client";

import { useState } from "react";
import { PagedDocumentTable } from "@/components/documents/DocumentList";
import { Card, PageHeader, Tabs } from "@/components/ui";

const ALL_FINISHED = "APPROVED,REJECTED,CANCELLED,ARCHIVED";

const tabs = [
  { value: ALL_FINISHED, label: "Wszystkie" },
  { value: "APPROVED,ARCHIVED", label: "Zatwierdzone" },
  { value: "REJECTED", label: "Odrzucone" },
  { value: "CANCELLED", label: "Wycofane" }
];

export default function FinishedPage() {
  const [status, setStatus] = useState(ALL_FINISHED);
  return (
    <>
      <PageHeader
        title="Zakończone"
        description="Dokumenty, w których uczestniczysz jako autor lub osoba decydująca, a ich cały obieg już się skończył. Nikt nie musi w nich nic więcej robić."
      />
      <Card>
        <Tabs value={status} onChange={setStatus} options={tabs} />
        <PagedDocumentTable filters={{ scope: "involved", status }} emptyTitle="Brak zakończonych dokumentów w tym widoku" />
      </Card>
    </>
  );
}
