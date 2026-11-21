"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { PagedDocumentTable } from "@/components/documents/DocumentList";
import { Card, Loading, PageHeader, Tabs } from "@/components/ui";

const tabs = [
  { value: "", label: "Wszystkie" },
  { value: "DRAFT", label: "Szkice" },
  { value: "NEEDS_CORRECTION", label: "Do poprawy" },
  { value: "IN_APPROVAL", label: "W akceptacji" },
  { value: "APPROVED,ARCHIVED", label: "Zatwierdzone" },
  { value: "REJECTED,CANCELLED", label: "Odrzucone i wycofane" }
];

function MyDocuments() {
  const params = useSearchParams();
  const [status, setStatus] = useState(params.get("status") ?? "");

  return (
    <>
      <PageHeader
        title="Moje dokumenty"
        description="Szkice, dokumenty w obiegu i zakończone." 
      />
      <Card>
        <Tabs value={status} onChange={setStatus} options={tabs} />
        <PagedDocumentTable filters={{ scope: "created-by-me", status }} emptyTitle="Brak dokumentów w tym widoku" />
      </Card>
    </>
  );
}

export default function MyDocumentsPage() {
  return <Suspense fallback={<Loading />}><MyDocuments /></Suspense>;
}
