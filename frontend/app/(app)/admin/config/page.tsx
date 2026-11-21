"use client";

import { Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, Banner, Card, EmptyState, ErrorBanner, Field, Loading, Modal, PageHeader } from "@/components/ui";
import { useToast } from "@/components/ui/toast";
import { apiRequest, errorText, patch, post, remove } from "@/lib/api";
import { dateTime, fullName } from "@/lib/format";
import { useConfigEntries, useMe } from "@/lib/queries";
import type { ConfigEntry, ConfigType } from "@/lib/types";

const TYPE_LABELS: Record<ConfigType, string> = { string: "tekst", number: "liczba", boolean: "tak/nie" };

function ValueInput({ type, value, onChange, secret }: { type: ConfigType; value: string; onChange: (value: string) => void; secret?: boolean }) {
  if (type === "boolean") {
    return (
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">(brak)</option>
        <option value="true">TAK</option>
        <option value="false">NIE</option>
      </select>
    );
  }
  return <input type={type === "number" ? "number" : secret ? "password" : "text"} value={value} maxLength={500} autoComplete="off" onChange={(event) => onChange(event.target.value)} />;
}

function DisplayValue({ entry }: { entry: ConfigEntry }) {
  if (entry.value === null || entry.value === "") return <span className="muted">(puste)</span>;
  if (entry.type === "boolean") return <Badge tone={entry.value === "true" ? "success" : "neutral"}>{entry.value === "true" ? "TAK" : "NIE"}</Badge>;
  return <code className="config-value">{entry.value}</code>;
}

function EditDialog({ entry, onClose }: { entry: ConfigEntry; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState(entry.value ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save(next: string | null) {
    setBusy(true);
    setError(null);
    try {
      await patch(`/config/${entry.id}`, { value: next });
      await client.invalidateQueries({ queryKey: ["config"] });
      toast.success(`Zapisano ${entry.key}`);
      onClose();
    } catch (saveError) {
      setError(saveError);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Edycja: ${entry.key}`}
      onClose={onClose}
      footer={(
        <>
          {entry.isSecret && entry.value && <button type="button" className="btn btn-danger-outline" onClick={() => save(null)} disabled={busy}>Wyczyść hasło</button>}
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Anuluj</button>
          <button type="button" className="btn btn-primary" onClick={() => save(entry.isSecret ? value || null : value.trim() || null)} disabled={busy}>{busy ? "Zapisywanie…" : "Zapisz"}</button>
        </>
      )}
    >
      <div className="stack">
        <ErrorBanner error={error} />
        {entry.description && <p className="muted">{entry.description}</p>}
        <Field label="Wartość" hint={entry.isSecret ? "Zostaw kropki, aby nie zmieniać hasła. Wpisz nowe, aby je zastąpić." : "Puste pole usuwa ustawienie."}>
          <ValueInput type={entry.type} value={value} onChange={setValue} secret={entry.isSecret} />
        </Field>
      </div>
    </Modal>
  );
}

function NewKeyDialog({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [key, setKey] = useState("");
  const [type, setType] = useState<ConfigType>("string");
  const [category, setCategory] = useState("");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      // Bez przycinania: API normalizuje wartość według klucza, a hasło musi zostać dokładnie takie, jak wpisano.
      await post("/config", { key, type, category, value: value || null, description });
      await client.invalidateQueries({ queryKey: ["config"] });
      toast.success(`Dodano ${key}`);
      onClose();
    } catch (saveError) {
      setError(saveError);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Nowy klucz"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Anuluj</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !key.trim()}>{busy ? "Zapisywanie…" : "Dodaj"}</button>
        </>
      )}
    >
      <div className="stack">
        <ErrorBanner error={error} />
        <Field label="Klucz" required hint="Litery, cyfry, kropka, myślnik i podkreślenie, np. LIMIT_PLIKU."><input value={key} maxLength={100} onChange={(event) => setKey(event.target.value)} /></Field>
        <Field label="Typ">
          <select value={type} onChange={(event) => { setType(event.target.value as ConfigType); setValue(""); }}>
            {(Object.keys(TYPE_LABELS) as ConfigType[]).map((item) => <option key={item} value={item}>{TYPE_LABELS[item]}</option>)}
          </select>
        </Field>
        <Field label="Kategoria" hint="np. System, Email"><input value={category} maxLength={50} onChange={(event) => setCategory(event.target.value)} /></Field>
        <Field label="Wartość"><ValueInput type={type} value={value} onChange={setValue} /></Field>
        <Field label="Opis"><input value={description} maxLength={300} onChange={(event) => setDescription(event.target.value)} /></Field>
      </div>
    </Modal>
  );
}

/**
 * Poczta bierze cały zestaw z jednego źródła (backend: getSmtpSettings): z tej tabeli, gdy jest w niej SMTP_HOST,
 * inaczej z pliku .env. Ekran musi to mówić wprost, bo puste pole znaczy co innego w każdym przypadku.
 */
function MailSourceBanner({ entries }: { entries: ConfigEntry[] }) {
  const host = entries.find((entry) => entry.key === "SMTP_HOST");
  if (!host) return null;
  if (host.value) {
    return (
      <Banner tone="info" title="Poczta korzysta wyłącznie z tej tabeli">
        Plik .env jest pomijany. Puste pole oznacza brak wartości: port 587, bez logowania, nadawca = login. Uzupełnij cały zestaw.
      </Banner>
    );
  }
  return (
    <Banner tone="info" title="Poczta korzysta z ustawień w pliku .env">
      SMTP_HOST jest pusty, więc pozostałe pola tej grupy nie są używane. Wpisanie SMTP_HOST przełącza całą pocztę na tę tabelę: wtedy uzupełnij też port, login, hasło i nadawcę.
    </Banner>
  );
}

/** Tryb skanera załączników z /api/health (tylko nazwa trybu, bez adresów). Ostrzega, gdy pliki nie są sprawdzane. */
function AntivirusBanner() {
  const health = useQuery({ queryKey: ["health"], queryFn: () => apiRequest<{ antivirus?: string }>("/health"), staleTime: 60_000 });
  const mode = health.data?.antivirus;
  if (mode === "disabled") {
    return <Banner tone="warning" title="Skanowanie antywirusowe jest wyłączone">Załączniki są dostępne bez sprawdzenia (AV_SCANNER=disabled). Włącz skaner w pliku .env serwera i uruchom ponownie API oraz worker.</Banner>;
  }
  if (mode === "unconfigured") {
    return <Banner tone="danger" title="Brak skanera antywirusowego">Załączniki czekają na skan i nie da się ich pobrać. Ustaw AV_SCANNER (defender, clamav albo disabled) w pliku .env serwera.</Banner>;
  }
  return null;
}

export default function ConfigPage() {
  const me = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const entries = useConfigEntries();
  const [editing, setEditing] = useState<ConfigEntry | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<ConfigEntry | null>(null);
  const [deleteError, setDeleteError] = useState<unknown>(null);

  if (!me.capabilities.manageConfig) return <Banner tone="danger" title="Brak dostępu">Ten widok jest dostępny dla administratora systemu.</Banner>;

  const groups = new Map<string, ConfigEntry[]>();
  for (const entry of entries.data ?? []) {
    const name = entry.category || "Inne";
    groups.set(name, [...(groups.get(name) ?? []), entry]);
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteError(null);
    try {
      await remove(`/config/${deleting.id}`);
      await client.invalidateQueries({ queryKey: ["config"] });
      toast.success(`Usunięto ${deleting.key}`);
      setDeleting(null);
    } catch (error) {
      setDeleteError(error);
    }
  }

  return (
    <>
      <PageHeader
        title="Konfiguracja systemu"
        description="Ustawienia programu, m.in. serwer poczty, z którego wychodzą powiadomienia. Zmiany działają w ciągu 30 sekund, bez restartu."
        actions={<button type="button" className="btn btn-primary" onClick={() => setAdding(true)}><Plus size={16} />Dodaj klucz</button>}
      />
      <AntivirusBanner />
      {entries.isPending && <Card><Loading /></Card>}
      {entries.error && <Banner tone="danger" title="Nie udało się wczytać konfiguracji">{errorText(entries.error)}</Banner>}
      {entries.data && !entries.data.length && <Card><EmptyState title="Brak kluczy konfiguracji" /></Card>}
      {[...groups.entries()].map(([category, items]) => (
        <Card key={category} title={category}>
          {category === "Email" && <MailSourceBanner entries={items} />}
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Klucz</th><th>Wartość</th><th>Typ</th><th>Opis</th><th>Ostatnia zmiana</th><th /></tr></thead>
              <tbody>
                {items.map((entry) => (
                  <tr key={entry.id}>
                    <td data-label="Klucz">
                      <span className="config-key">{entry.isSystem && <Lock size={13} aria-label="Klucz systemowy" />}<strong>{entry.key}</strong></span>
                    </td>
                    <td data-label="Wartość"><DisplayValue entry={entry} /></td>
                    <td data-label="Typ"><Badge>{TYPE_LABELS[entry.type] ?? entry.type}</Badge></td>
                    <td data-label="Opis"><small className="muted">{entry.description}</small></td>
                    <td data-label="Ostatnia zmiana">
                      <small>{dateTime(entry.updatedAt)}</small>
                      <small className="muted">{entry.updatedBy ? `przez: ${fullName(entry.updatedBy)}` : "przez: program"}</small>
                    </td>
                    <td className="row-actions">
                      {!entry.isReadOnly && <button type="button" className="icon-btn" aria-label={`Edytuj ${entry.key}`} onClick={() => setEditing(entry)}><Pencil size={16} /></button>}
                      {!entry.isSystem && <button type="button" className="icon-btn" aria-label={`Usuń ${entry.key}`} onClick={() => { setDeleteError(null); setDeleting(entry); }}><Trash2 size={16} /></button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
      {editing && <EditDialog entry={editing} onClose={() => setEditing(null)} />}
      {adding && <NewKeyDialog onClose={() => setAdding(false)} />}
      {deleting && (
        <Modal
          title={`Usunąć ${deleting.key}?`}
          onClose={() => setDeleting(null)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setDeleting(null)}>Anuluj</button>
              <button type="button" className="btn btn-danger" onClick={confirmDelete}>Usuń</button>
            </>
          )}
        >
          <ErrorBanner error={deleteError} />
          <p>Klucz zniknie z konfiguracji. Zmiana trafi do dziennika zdarzeń.</p>
        </Modal>
      )}
    </>
  );
}
