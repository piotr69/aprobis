"use client";

import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { DocumentForm, type DocumentFormValues } from "@/components/documents/DocumentForm";
import { Banner, Card, Loading, PageHeader } from "@/components/ui";
import { errorText, patch } from "@/lib/api";
import { parseData } from "@/lib/format";
import { useDocument, useInvalidateWork } from "@/lib/queries";

export default function EditDocumentPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const query = useDocument(id);
  const invalidate = useInvalidateWork();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (query.isPending) return <Loading />;
  if (query.error || !query.data) return <Banner tone="danger" title="Nie udało się otworzyć dokumentu">{errorText(query.error)}</Banner>;
  const document = query.data;
  if (!document.actionsAllowed.canEdit) {
    return <Banner tone="warning" title="Tego dokumentu nie można teraz edytować">Edytować można tylko własny szkic albo dokument zwrócony do poprawy.</Banner>;
  }

  async function save(values: DocumentFormValues) {
    setBusy(true);
    setError(null);
    try {
      await patch(`/documents/${id}`, {
        expectedVersion: document.version,
        title: values.title,
        amount: values.amount,
        currency: values.currency,
        contractorName: values.contractorName,
        data: values.data
      });
      await invalidate();
      router.push(`/documents/${id}`);
    } catch (saveError) {
      setError(saveError);
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Edycja dokumentu" description={`${document.number} · ${document.type.name}`} />
      <Card>
        <DocumentForm
          typeName={document.type.name}
          fields={document.formFields}
          requiresAmount={document.type.requiresAmount}
          requiresContractor={document.type.requiresContractor}
          titleTemplate={document.formTitleTemplate}
          initial={{
            title: document.title,
            amount: document.amount,
            currency: document.currency,
            contractorName: document.contractorName,
            data: parseData(document.dataJson ?? document.metadataJson)
          }}
          submitLabel="Zapisz zmiany"
          busy={busy}
          error={error}
          onSubmit={save}
          onCancel={() => router.push(`/documents/${id}`)}
        />
      </Card>
    </>
  );
}
