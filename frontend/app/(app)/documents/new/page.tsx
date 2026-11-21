"use client";

import { ArrowLeft, ChevronRight, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { DocumentForm, type DocumentFormValues } from "@/components/documents/DocumentForm";
import { Banner, Card, EmptyState, Loading, PageHeader } from "@/components/ui";
import { useToast } from "@/components/ui/toast";
import { apiRequest, post } from "@/lib/api";
import { categoryLabels, categoryOrder } from "@/lib/format";
import { useDocumentTypes, useInvalidateWork, useMe } from "@/lib/queries";
import type { DocumentType } from "@/lib/types";

function TypePicker({ types, onPick }: { types: DocumentType[]; onPick: (type: DocumentType) => void }) {
  const [phrase, setPhrase] = useState("");
  const groups = useMemo(() => {
    const needle = phrase.trim().toLocaleLowerCase("pl-PL");
    const matching = types.filter((type) => type.isActive && (!needle || type.name.toLocaleLowerCase("pl-PL").includes(needle)));
    return categoryOrder
      .map((category) => ({ category, items: matching.filter((type) => type.category === category) }))
      .filter((group) => group.items.length);
  }, [types, phrase]);

  return (
    <Card>
      <div className="search-input search-input-large">
        <Search size={18} aria-hidden="true" />
        <input type="search" aria-label="Szukaj typu dokumentu" placeholder="Szukaj, np. faktura, urlop, umowa" value={phrase} onChange={(event) => setPhrase(event.target.value)} autoFocus />
      </div>
      {!groups.length && <EmptyState title="Nie ma takiego typu dokumentu">Spróbuj innego słowa.</EmptyState>}
      {groups.map((group) => (
        <div key={group.category} className="type-group">
          <h2>{categoryLabels[group.category] ?? group.category}</h2>
          <div className="type-grid">
            {group.items.map((type) => (
              <button key={type.id} type="button" className="type-card" onClick={() => onPick(type)}>
                <span>{type.name}</span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>
      ))}
    </Card>
  );
}

export default function NewDocumentPage() {
  const router = useRouter();
  const me = useMe();
  const toast = useToast();
  const types = useDocumentTypes();
  const invalidate = useInvalidateWork();
  const [selected, setSelected] = useState<DocumentType | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (!me.capabilities.createDocuments) return <Banner tone="danger" title="Brak dostępu">Twoja rola nie pozwala tworzyć dokumentów.</Banner>;

  async function save(values: DocumentFormValues) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const created = await post<{ id: string }>("/documents", {
        title: values.title,
        typeId: selected.id,
        amount: values.amount,
        currency: values.currency,
        contractorName: values.contractorName,
        data: values.data
      });
      const failed: string[] = [];
      for (const file of values.files) {
        const form = new FormData();
        form.append("file", file);
        await apiRequest(`/documents/${created.id}/files`, { method: "POST", body: form }).catch(() => failed.push(file.name));
      }
      if (failed.length) toast.error(`Dokument zapisano, ale nie dodano plików: ${failed.join(", ")}`);
      await invalidate();
      router.push(`/documents/${created.id}`);
    } catch (saveError) {
      setError(saveError);
      setBusy(false);
    }
  }

  if (!selected) {
    return (
      <>
        <PageHeader title="Nowy dokument" description="Wybierz, jaki dokument chcesz utworzyć." />
        {types.isPending ? <Loading /> : <TypePicker types={types.data ?? []} onPick={setSelected} />}
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={selected.name}
        description="Uzupełnij dane. Dokument zapisze się jako szkic, a przed złożeniem zobaczysz, kto będzie go akceptować."
        actions={<button type="button" className="btn" onClick={() => setSelected(null)}><ArrowLeft size={16} />Inny typ</button>}
      />
      <Card>
        <DocumentForm
          key={selected.id}
          typeName={selected.name}
          fields={selected.fields}
          requiresAmount={selected.requiresAmount}
          requiresContractor={selected.requiresContractor}
          titleTemplate={selected.titleTemplate}
          submitLabel="Zapisz i przejdź dalej"
          allowFiles
          busy={busy}
          error={error}
          onSubmit={save}
          onCancel={() => router.back()}
        />
      </Card>
    </>
  );
}
