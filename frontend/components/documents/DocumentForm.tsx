"use client";

import { Upload } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { ErrorBanner, Field } from "@/components/ui";
import { applyTitleTemplate } from "@/lib/format";
import type { FormField } from "@/lib/types";

export type DocumentFormValues = {
  title: string;
  amount: string | null;
  currency: string;
  contractorName: string | null;
  data: Record<string, unknown>;
  files: File[];
};

type Props = {
  typeName: string;
  fields: FormField[];
  requiresAmount: boolean;
  requiresContractor: boolean;
  titleTemplate?: string | null;
  initial?: { title?: string; amount?: string | number | null; currency?: string; contractorName?: string | null; data?: Record<string, unknown> };
  submitLabel: string;
  allowFiles?: boolean;
  busy: boolean;
  error: unknown;
  onSubmit: (values: DocumentFormValues) => void;
  onCancel: () => void;
};

function initialFieldValue(field: FormField, value: unknown) {
  if (value === undefined || value === null) return "";
  return String(value);
}

function DynamicField({ field, value, onChange }: { field: FormField; value: string; onChange: (value: string) => void }) {
  if (field.type === "select") {
    return (
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Wybierz…</option>
        {(field.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    );
  }
  if (field.type === "boolean") {
    return (
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Wybierz…</option>
        <option value="true">Tak</option>
        <option value="false">Nie</option>
      </select>
    );
  }
  if (field.type === "textarea") {
    return <textarea rows={3} value={value} placeholder={field.placeholder} onChange={(event) => onChange(event.target.value)} />;
  }
  return (
    <input
      type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
      step={field.type === "number" ? "any" : undefined}
      value={value}
      placeholder={field.placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/**
 * Wspólny formularz nowego dokumentu i korekty. Pola obowiązkowe są oznaczone, ale
 * sprawdza je dopiero złożenie: szkic można zapisać w każdej chwili i dokończyć później.
 */
export function DocumentForm({ typeName, fields, requiresAmount, requiresContractor, titleTemplate, initial, submitLabel, allowFiles, busy, error, onSubmit, onCancel }: Props) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [amount, setAmount] = useState(initial?.amount === null || initial?.amount === undefined ? "" : String(initial.amount));
  const [currency, setCurrency] = useState(initial?.currency ?? "PLN");
  const [contractor, setContractor] = useState(initial?.contractorName ?? "");
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((field) => [field.key, initialFieldValue(field, initial?.data?.[field.key])]))
  );
  const [files, setFiles] = useState<File[]>([]);

  const data = useMemo(() => {
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const value = values[field.key]?.trim();
      if (value) result[field.key] = field.type === "boolean" ? value === "true" : value;
    }
    return result;
  }, [fields, values]);

  // Tytuł z szablonu powstaje z pól: gdy użytkownik jeszcze ich nie wypełnił, przyda się nazwa typu.
  const generatedTitle = titleTemplate ? applyTitleTemplate(titleTemplate, fields, data) : "";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit({
      // Puste pola nie mogą skasować tytułu, który dokument już ma.
      title: titleTemplate ? (generatedTitle.length >= 3 ? generatedTitle : initial?.title ?? typeName) : title.trim(),
      amount: amount.trim() ? amount.trim().replace(",", ".") : null,
      currency,
      contractorName: contractor.trim() || null,
      data,
      files
    });
  }

  return (
    <form className="stack" onSubmit={submit}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        {titleTemplate ? (
          <Field label="Tytuł" wide hint="Tworzy się automatycznie na podstawie pól poniżej.">
            <input value={generatedTitle || typeName} readOnly />
          </Field>
        ) : (
          <Field label="Tytuł" required wide>
            <input value={title} onChange={(event) => setTitle(event.target.value)} required minLength={3} maxLength={240} placeholder="Krótko: czego dotyczy dokument" autoFocus />
          </Field>
        )}
        {requiresContractor && (
          <Field label="Kontrahent" required wide>
            <input value={contractor} onChange={(event) => setContractor(event.target.value)} maxLength={240} />
          </Field>
        )}
        {requiresAmount && (
          <>
            <Field label="Kwota" required>
              <input type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0,00" />
            </Field>
            <Field label="Waluta" required>
              <select value={currency} onChange={(event) => setCurrency(event.target.value)}>
                <option value="PLN">PLN</option>
                <option value="EUR">EUR</option>
                <option value="USD">USD</option>
              </select>
            </Field>
          </>
        )}
        {fields.map((field) => (
          <Field key={field.key} label={field.label} required={field.required} wide={field.type === "textarea"}>
            <DynamicField field={field} value={values[field.key] ?? ""} onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))} />
          </Field>
        ))}
      </div>

      {allowFiles && (
        <div className="field">
          <span className="field-label">Załączniki</span>
          <label className="file-drop">
            <Upload size={18} aria-hidden="true" />
            <span>{files.length ? files.map((file) => file.name).join(", ") : "Wybierz pliki: PDF, Word, Excel, obrazy, TXT lub CSV (do 25 MB)"}</span>
            <input type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.gif,.txt,.csv" onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />
          </label>
        </div>
      )}

      <div className="form-actions">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>Anuluj</button>
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Zapisywanie…" : submitLabel}</button>
      </div>
    </form>
  );
}
