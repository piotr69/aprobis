"use client";

import { useState } from "react";
import { PagedDocumentTable } from "@/components/documents/DocumentList";
import { Banner, Card, PageHeader, Tabs } from "@/components/ui";
import { useMe } from "@/lib/queries";

export default function ArchivePage() {
  const me = useMe();
  const [status, setStatus] = useState<"APPROVED" | "ARCHIVED">("APPROVED");

  if (!me.capabilities.archiveDocuments) return <Banner tone="danger" title="Brak dostępu">Ten widok jest dostępny dla osób prowadzących archiwum.</Banner>;

  return (
    <>
      <PageHeader title="Do archiwizacji" description="Zatwierdzone dokumenty czekające na przeniesienie do archiwum. Otwórz dokument, aby go zarchiwizować." />
      <Card>
        <Tabs
          value={status}
          onChange={setStatus}
          options={[{ value: "APPROVED", label: "Czekają" }, { value: "ARCHIVED", label: "W archiwum" }]}
        />
        <PagedDocumentTable filters={{ status }} emptyTitle={status === "APPROVED" ? "Nic nie czeka na archiwizację" : "Archiwum jest puste"} />
      </Card>
    </>
  );
}
