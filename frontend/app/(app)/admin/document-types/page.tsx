"use client";

import { ArrowDown, ArrowUp, Plus, Search, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Badge, Banner, Card, EmptyState, ErrorBanner, Field, Loading, Modal, PageHeader } from "@/components/ui";
import { useToast } from "@/components/ui/toast";
import { errorText, patch, post } from "@/lib/api";
import { categoryLabels, categoryOrder } from "@/lib/format";
import { useDocumentTypes, useMe } from "@/lib/queries";
import type { DocumentType, FieldType, FormField } from "@/lib/types";

const fieldTypeLabels: Record<FieldType, string> = {
  text: "Tekst",
  textarea: "Długi tekst",
  number: "Liczba",
  date: "Data",
  select: "Lista wyboru",
  boolean: "Tak / nie"
};

/** Klucz pola z etykiety: użytkownik nie musi go wymyślać, a dane dokumentów zostają stabilne. */
function keyFromLabel(label: string, taken: string[]) {
  const base = label
    .toLocaleLowerCase("pl-PL")
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "pole";
  const start = /^[a-z]/.test(base) ? base : `pole_${base}`;
  let candidate = start;
  for (let suffix = 2; taken.includes(candidate); suffix += 1) candidate = `${start}_${suffix}`;
  return candidate.slice(0, 100);
}

function TypeDialog({ type, onClose }: { type?: DocumentType; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(type?.name ?? "");
  const [code, setCode] = useState(type?.code ?? "");
  const [category, setCategory] = useState(type?.category ?? "ADMIN");
  const [requiresAmount, setRequiresAmount] = useState(type?.requiresAmount ?? false);
  const [requiresContractor, setRequiresContractor] = useState(type?.requiresContractor ?? false);
  const [isActive, setIsActive] = useState(type?.isActive ?? true);
  const [titleTemplate, setTitleTemplate] = useState(type?.titleTemplate ?? "");
  const [fields, setFields] = useState<FormField[]>(type?.fields ?? []);
  const [newKeys] = useState(() => new Set<number>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function updateField(index: number, patchValue: Partial<FormField>) {
    setFields((current) => current.map((field, position) => {
      if (position !== index) return field;
      const next = { ...field, ...patchValue };
      // Klucz nowego pola idzie za etykietą; istniejącego nie ruszamy, bo są pod nim zapisane dane.
      if (patchValue.label !== undefined && newKeys.has(index)) {
        next.key = keyFromLabel(patchValue.label, current.filter((_, other) => other !== index).map((item) => item.key));
      }
      return next;
    }));
  }

  function addField() {
    newKeys.add(fields.length);
    setFields((current) => [...current, { key: keyFromLabel("pole", current.map((item) => item.key)), label: "", type: "text", required: false }]);
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= fields.length) return;
    const wasNew = newKeys.has(index);
    const otherNew = newKeys.has(target);
    newKeys.delete(index);
    newKeys.delete(target);
    if (wasNew) newKeys.add(target);
    if (otherNew) newKeys.add(index);
    setFields((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function removeField(index: number) {
    newKeys.clear();
    setFields((current) => current.filter((_, position) => position !== index));
  }

  async function save() {
    setBusy(true);
    setError(null);
    const fieldsChanged = !type || JSON.stringify(fields) !== JSON.stringify(type.fields) || (titleTemplate || "") !== (type.titleTemplate ?? "");
    const body = {
      name, code, category, requiresAmount, requiresContractor, isActive,
      titleTemplate: titleTemplate.trim() || null,
      // Nowa wersja formularza powstaje tylko wtedy, gdy formularz faktycznie się zmienił.
      ...(fieldsChanged ? { fields } : {})
    };
    try {
      const saved = type
        ? await patch<{ id: string; draftVersion?: { id: string } | null }>(`/document-types/${type.id}`, body)
        : await post<{ id: string; draftVersion?: { id: string } | null }>("/document-types", { ...body, fields });
      if (saved.draftVersion) await post(`/document-types/${saved.id}/versions/${saved.draftVersion.id}/publish`);
      await client.invalidateQueries({ queryKey: ["document-types"] });
      toast.success("Zapisano typ dokumentu");
      onClose();
    } catch (saveError) {
      setError(saveError);
      setBusy(false);
    }
  }

  return (
    <Modal
      size="lg"
      title={type ? `Edycja: ${type.name}` : "Nowy typ dokumentu"}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Anuluj</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>{busy ? "Zapisywanie…" : "Zapisz"}</button>
        </>
      )}
    >
      <div className="stack">
        <ErrorBanner error={error} />
        <div className="form-grid">
          <Field label="Nazwa" required wide><input value={name} maxLength={180} onChange={(event) => setName(event.target.value)} /></Field>
          <Field label="Kod" required hint="Krótki identyfikator, np. FAKTURA_KOSZTOWA. Używają go reguły."><input value={code} maxLength={60} onChange={(event) => setCode(event.target.value)} /></Field>
          <Field label="Kategoria" required hint="Decyduje, kto widzi te dokumenty, np. kadry albo księgowość.">
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              {categoryOrder.map((value) => <option key={value} value={value}>{categoryLabels[value]}</option>)}
            </select>
          </Field>
          <Field label="Szablon tytułu" wide hint="Puste: autor wpisuje tytuł sam. Przykład: Wniosek urlopowy {vacationStart} - {vacationEnd}">
            <input value={titleTemplate} maxLength={240} onChange={(event) => setTitleTemplate(event.target.value)} />
          </Field>
        </div>
        <div className="check-row">
          <label className="check"><input type="checkbox" checked={requiresAmount} onChange={(event) => setRequiresAmount(event.target.checked)} />Kwota wymagana</label>
          <label className="check"><input type="checkbox" checked={requiresContractor} onChange={(event) => setRequiresContractor(event.target.checked)} />Kontrahent wymagany</label>
          <label className="check"><input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />Dostępny przy tworzeniu dokumentów</label>
        </div>

        <h3>Pola formularza</h3>
        <p className="muted small">Zmiany dotyczą nowych dokumentów. Istniejące zachowują swój formularz.</p>
        {fields.map((field, index) => (
          <div key={index} className="field-row">
            <Field label="Etykieta" required><input value={field.label} onChange={(event) => updateField(index, { label: event.target.value })} /></Field>
            <Field label="Rodzaj">
              <select value={field.type} onChange={(event) => updateField(index, { type: event.target.value as FieldType })}>
                {Object.entries(fieldTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            {field.type === "select" && (
              <Field label="Opcje" hint="Oddziel przecinkami.">
                <input
                  defaultValue={(field.options ?? []).join(", ")}
                  onBlur={(event) => updateField(index, { options: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })}
                />
              </Field>
            )}
            <label className="check field-row-check"><input type="checkbox" checked={field.required} onChange={(event) => updateField(index, { required: event.target.checked })} />Wymagane</label>
            <div className="field-row-tools">
              <button type="button" className="icon-btn" aria-label="Przesuń wyżej" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={16} /></button>
              <button type="button" className="icon-btn" aria-label="Przesuń niżej" disabled={index === fields.length - 1} onClick={() => move(index, 1)}><ArrowDown size={16} /></button>
              <button type="button" className="icon-btn" aria-label="Usuń pole" onClick={() => removeField(index)}><Trash2 size={16} /></button>
            </div>
          </div>
        ))}
        <div><button type="button" className="btn btn-sm" onClick={addField}><Plus size={14} />Dodaj pole</button></div>
      </div>
    </Modal>
  );
}

export default function DocumentTypesPage() {
  const me = useMe();
  const types = useDocumentTypes();
  const [phrase, setPhrase] = useState("");
  const [editing, setEditing] = useState<DocumentType | "new" | null>(null);

  const filtered = useMemo(() => {
    const needle = phrase.trim().toLocaleLowerCase("pl-PL");
    return (types.data ?? []).filter((type) => !needle || `${type.name} ${type.code}`.toLocaleLowerCase("pl-PL").includes(needle));
  }, [types.data, phrase]);

  if (!me.capabilities.configureDocumentTypes) return <Banner tone="danger" title="Brak dostępu">Ten widok jest dostępny dla administratorów.</Banner>;

  return (
    <>
      <PageHeader
        title="Typy dokumentów"
        description="Jakie dokumenty można tworzyć i jakie mają pola."
        actions={<button type="button" className="btn btn-primary" onClick={() => setEditing("new")}><Plus size={16} />Nowy typ</button>}
      />
      <Card>
        <div className="toolbar">
          <div className="search-input">
            <Search size={16} aria-hidden="true" />
            <input type="search" aria-label="Szukaj typu" placeholder="Szukaj typu dokumentu" value={phrase} onChange={(event) => setPhrase(event.target.value)} />
          </div>
        </div>
        {types.isPending && <Loading />}
        {types.error && <Banner tone="danger" title="Nie udało się wczytać typów">{errorText(types.error)}</Banner>}
        {types.data && !filtered.length && <EmptyState title="Nie znaleziono typów" />}
        {filtered.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Typ</th><th>Kategoria</th><th className="num">Pola</th><th>Status</th><th /></tr></thead>
              <tbody>
                {filtered.map((type) => (
                  <tr key={type.id}>
                    <td data-label="Typ"><strong>{type.name}</strong><small className="muted">{type.code}</small></td>
                    <td data-label="Kategoria">{categoryLabels[type.category] ?? type.category}</td>
                    <td data-label="Pola" className="num">{type.fields.length}</td>
                    <td data-label="Status"><Badge tone={type.isActive ? "success" : "neutral"}>{type.isActive ? "Aktywny" : "Wyłączony"}</Badge></td>
                    <td className="row-actions"><button type="button" className="btn btn-sm" onClick={() => setEditing(type)}>Edytuj</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && <TypeDialog type={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </>
  );
}
