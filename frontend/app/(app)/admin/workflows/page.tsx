"use client";

import { Plus } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { definitionStepToEditor, newStep, schemaStepPayload, StepsEditor } from "@/components/admin/StepsEditor";
import { Badge, Banner, Card, EmptyState, ErrorBanner, Field, Loading, Modal, PageHeader, Tabs } from "@/components/ui";
import { useToast } from "@/components/ui/toast";
import { apiRequest, errorText, patch, post } from "@/lib/api";
import { assigneeTypeLabels, categoryLabels, categoryOrder } from "@/lib/format";
import { useDepartments, useDocumentTypes, useMe, useRoles } from "@/lib/queries";
import type { ApprovalRule, DocumentType, WorkflowDefinition, WorkflowOverviewItem, WorkflowStepConfig } from "@/lib/types";

type RuleDraft = {
  id?: string;
  name: string;
  priority: number;
  isActive: boolean;
  documentTypeCodes: string[];
  categories: string[];
  departmentCodes: string[];
  amountMin: string;
  amountMax: string;
  currencies: string[];
  keywords: string;
  stopProcessing: boolean;
  validFrom: string;
  validTo: string;
  steps: WorkflowStepConfig[];
  /** Warunki spoza formularza (np. lokalizacja): nie mogą zniknąć przy zapisie. */
  preserved: Record<string, unknown>;
};

function parse(raw: string): Record<string, any> {
  try {
    return JSON.parse(raw) ?? {};
  } catch {
    return {};
  }
}

function toDraft(rule?: ApprovalRule): RuleDraft {
  if (!rule) {
    return {
      name: "", priority: 100, isActive: true, documentTypeCodes: [], categories: [], departmentCodes: [], amountMin: "", amountMax: "",
      currencies: [], keywords: "", stopProcessing: true, validFrom: "", validTo: "", steps: [newStep()], preserved: {}
    };
  }
  const { documentTypeCodes, categories, departmentCodes, amountMin, amountMax, currency, currencies, keywords, ...preserved } = parse(rule.conditionsJson);
  const actions = parse(rule.actionsJson);
  return {
    id: rule.id,
    name: rule.name,
    priority: rule.priority,
    isActive: rule.isActive,
    documentTypeCodes: documentTypeCodes ?? [],
    categories: categories ?? [],
    departmentCodes: departmentCodes ?? [],
    amountMin: amountMin === undefined ? "" : String(amountMin),
    amountMax: amountMax === undefined ? "" : String(amountMax),
    currencies: currencies ?? (currency ? [currency] : []),
    keywords: (keywords ?? []).join(", "),
    stopProcessing: Boolean(actions.stopProcessing),
    validFrom: rule.validFrom?.slice(0, 10) ?? "",
    validTo: rule.validTo?.slice(0, 10) ?? "",
    steps: (actions.steps ?? []).map((step: Partial<WorkflowStepConfig>) => ({ ...newStep(), ...step })),
    preserved
  };
}

function rulePayload(draft: RuleDraft, documentTypeId: string | null | undefined) {
  const conditions: Record<string, unknown> = { ...draft.preserved };
  if (draft.documentTypeCodes.length) conditions.documentTypeCodes = draft.documentTypeCodes;
  if (draft.categories.length) conditions.categories = draft.categories;
  if (draft.departmentCodes.length) conditions.departmentCodes = draft.departmentCodes;
  if (draft.amountMin.trim()) conditions.amountMin = Number(draft.amountMin);
  if (draft.amountMax.trim()) conditions.amountMax = Number(draft.amountMax);
  if (draft.currencies.length) conditions.currencies = draft.currencies;
  const keywords = draft.keywords.split(",").map((item) => item.trim()).filter(Boolean);
  if (keywords.length) conditions.keywords = keywords;
  const steps = draft.steps.map((step) => {
    const { id: _id, ...rest } = step;
    return Object.fromEntries(Object.entries({ ...rest, name: rest.name.trim() }).filter(([, value]) => value !== null && value !== undefined));
  });
  return {
    name: draft.name.trim(),
    priority: draft.priority,
    isActive: draft.isActive,
    documentTypeId: documentTypeId ?? null,
    conditionsJson: JSON.stringify(conditions),
    actionsJson: JSON.stringify({ stopProcessing: draft.stopProcessing, steps }),
    validFrom: draft.validFrom || null,
    validTo: draft.validTo || null
  };
}

function MultiCheck({ label, options, values, onChange }: { label: string; options: Array<{ value: string; label: string }>; values: string[]; onChange: (values: string[]) => void }) {
  return (
    <fieldset className="multi-check">
      <legend>{label}</legend>
      <div className="multi-check-list">
        {options.map((option) => (
          <label key={option.value} className="check">
            <input
              type="checkbox"
              checked={values.includes(option.value)}
              onChange={(event) => onChange(event.target.checked ? [...values, option.value] : values.filter((value) => value !== option.value))}
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function describeConditions(rule: ApprovalRule) {
  const conditions = parse(rule.conditionsJson);
  const parts: string[] = [];
  if (conditions.documentTypeCodes?.length) parts.push(`typy: ${conditions.documentTypeCodes.length}`);
  if (conditions.categories?.length) parts.push(`kategoria: ${conditions.categories.map((item: string) => categoryLabels[item] ?? item).join(", ")}`);
  if (conditions.amountMin !== undefined) parts.push(`od ${conditions.amountMin}`);
  if (conditions.amountMax !== undefined) parts.push(`do ${conditions.amountMax}`);
  const currencies = conditions.currencies ?? (conditions.currency ? [conditions.currency] : []);
  if (currencies.length) parts.push(currencies.join("/"));
  if (conditions.departmentCodes?.length) parts.push(`działy: ${conditions.departmentCodes.join(", ")}`);
  if (conditions.keywords?.length) parts.push(`słowa: ${conditions.keywords.join(", ")}`);
  return parts.join(" · ") || "Każdy dokument";
}

function RuleDialog({ rule, types, onClose }: { rule?: ApprovalRule; types: DocumentType[]; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const departments = useDepartments();
  const [draft, setDraft] = useState(() => toDraft(rule));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = (patchValue: Partial<RuleDraft>) => setDraft((current) => ({ ...current, ...patchValue }));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = rulePayload(draft, rule?.documentTypeId);
      if (rule) await patch(`/rules/${rule.id}`, payload);
      else await post("/rules", payload);
      await client.invalidateQueries({ queryKey: ["rules"] });
      toast.success("Reguła zapisana");
      onClose();
    } catch (saveError) {
      setError(saveError);
      setBusy(false);
    }
  }

  return (
    <Modal
      size="lg"
      title={rule ? "Edycja reguły" : "Nowa reguła"}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Anuluj</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !draft.name.trim() || !draft.steps.length}>{busy ? "Zapisywanie…" : "Zapisz regułę"}</button>
        </>
      )}
    >
      <div className="stack">
        <ErrorBanner error={error} />
        <div className="form-grid">
          <Field label="Nazwa" required wide><input value={draft.name} maxLength={180} onChange={(event) => set({ name: event.target.value })} /></Field>
          <Field label="Kolejność sprawdzania" hint="Niższa liczba: sprawdzana wcześniej."><input type="number" value={draft.priority} onChange={(event) => set({ priority: Number(event.target.value) })} /></Field>
          <Field label="Status">
            <select value={draft.isActive ? "1" : "0"} onChange={(event) => set({ isActive: event.target.value === "1" })}>
              <option value="1">Aktywna</option>
              <option value="0">Wyłączona</option>
            </select>
          </Field>
          <Field label="Obowiązuje od"><input type="date" value={draft.validFrom} onChange={(event) => set({ validFrom: event.target.value })} /></Field>
          <Field label="Obowiązuje do"><input type="date" value={draft.validTo} onChange={(event) => set({ validTo: event.target.value })} /></Field>
        </div>

        <h3>Kiedy reguła ma zadziałać?</h3>
        <p className="muted small">Puste pole oznacza „bez ograniczeń”. Dokument musi spełnić wszystkie wypełnione warunki.</p>
        <MultiCheck label="Kategorie" options={categoryOrder.map((value) => ({ value, label: categoryLabels[value] }))} values={draft.categories} onChange={(categories) => set({ categories })} />
        <MultiCheck label="Typy dokumentów" options={types.map((type) => ({ value: type.code, label: type.name }))} values={draft.documentTypeCodes} onChange={(documentTypeCodes) => set({ documentTypeCodes })} />
        <MultiCheck label="Działy autora" options={(departments.data ?? []).map((department) => ({ value: department.code, label: department.name }))} values={draft.departmentCodes} onChange={(departmentCodes) => set({ departmentCodes })} />
        <div className="form-grid">
          <Field label="Kwota od"><input type="number" min={0} value={draft.amountMin} onChange={(event) => set({ amountMin: event.target.value })} /></Field>
          <Field label="Kwota do"><input type="number" min={0} value={draft.amountMax} onChange={(event) => set({ amountMax: event.target.value })} /></Field>
          <Field label="Słowa w tytule" wide hint="Oddziel przecinkami. Wystarczy jedno z nich."><input value={draft.keywords} onChange={(event) => set({ keywords: event.target.value })} /></Field>
        </div>
        <MultiCheck label="Waluty" options={["PLN", "EUR", "USD"].map((value) => ({ value, label: value }))} values={draft.currencies} onChange={(currencies) => set({ currencies })} />

        <h3>Jakie etapy dodać?</h3>
        <StepsEditor steps={draft.steps} onChange={(steps) => set({ steps })} />
        <label className="check">
          <input type="checkbox" checked={draft.stopProcessing} onChange={(event) => set({ stopProcessing: event.target.checked })} />
          Nie sprawdzaj kolejnych reguł, gdy ta zadziała
        </label>
      </div>
    </Modal>
  );
}

function RulesTab({ types }: { types: DocumentType[] }) {
  const rules = useQuery({ queryKey: ["rules"], queryFn: () => apiRequest<ApprovalRule[]>("/rules") });
  const [editing, setEditing] = useState<ApprovalRule | "new" | null>(null);

  return (
    <Card
      title="Reguły warunkowe"
      aside={<button type="button" className="btn btn-sm" onClick={() => setEditing("new")}><Plus size={14} />Nowa reguła</button>}
    >
      <p className="muted small">Reguły układają ścieżkę na podstawie kwoty, kategorii czy działu. Sprawdzane są po kolei. Gdy żadna nie pasuje, dokument akceptuje przełożony autora.</p>
      {rules.isPending && <Loading />}
      {rules.error && <Banner tone="danger" title="Nie udało się wczytać reguł">{errorText(rules.error)}</Banner>}
      {rules.data && !rules.data.length && <EmptyState title="Brak reguł" />}
      {rules.data && rules.data.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Kolejność</th><th>Nazwa i warunki</th><th>Etapy</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rules.data.map((rule) => {
                const steps: Array<{ name: string }> = parse(rule.actionsJson).steps ?? [];
                return (
                  <tr key={rule.id}>
                    <td data-label="Kolejność">{rule.priority}</td>
                    <td data-label="Nazwa">
                      <strong>{rule.name}</strong>
                      <small className="muted">{describeConditions(rule)}</small>
                    </td>
                    <td data-label="Etapy">{steps.map((step) => step.name).join(" → ") || "—"}</td>
                    <td data-label="Status"><Badge tone={rule.isActive ? "success" : "neutral"}>{rule.isActive ? "Aktywna" : "Wyłączona"}</Badge></td>
                    <td className="row-actions"><button type="button" className="btn btn-sm" onClick={() => setEditing(rule)}>Edytuj</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && <RuleDialog rule={editing === "new" ? undefined : editing} types={types} onClose={() => setEditing(null)} />}
    </Card>
  );
}

const completionText = (mode: string, count: number) => (count > 1 ? (mode === "ANY" ? " (wystarczy jedna)" : " (wszyscy)") : "");

function describeConditionsObject(conditions: Record<string, any>) {
  const parts: string[] = [];
  if (conditions.amountMin !== undefined) parts.push(`kwota od ${conditions.amountMin}`);
  if (conditions.amountMax !== undefined) parts.push(`kwota do ${conditions.amountMax}`);
  const currencies = conditions.currencies ?? (conditions.currency ? [conditions.currency] : []);
  if (currencies.length) parts.push(currencies.join("/"));
  if (conditions.departmentCodes?.length) parts.push(`działy: ${conditions.departmentCodes.join(", ")}`);
  if (conditions.location) parts.push(`lokalizacja: ${conditions.location}`);
  if (conditions.keywords?.length) parts.push(`słowa: ${conditions.keywords.join(", ")}`);
  return parts.join(" · ") || "każdy dokument tego typu";
}

/** „Ścieżka teraz” jednego typu: ten sam wybór źródła co w silniku. */
function CurrentPath({ item, roleLabel }: { item: WorkflowOverviewItem; roleLabel: (role?: string | null) => string | undefined }) {
  if (item.source === "SCHEMA" && item.definition) {
    return (
      <div className="overview-path">
        <span><Badge tone="success">Schemat v{item.definition.version}</Badge></span>
        <span>
          {item.definition.steps.map((step) => {
            const who = step.people.length
              ? step.people.join(", ") + (step.stageKind === "INFO" ? "" : completionText(step.completionMode, step.people.length))
              : `${assigneeTypeLabels[step.assigneeType] ?? step.assigneeType}${step.assigneeRole ? `: ${roleLabel(step.assigneeRole)}` : ""}`;
            return `${step.name} (${who}${step.stageKind === "INFO" ? ", do wiadomości" : ""})${step.conditional ? " [warunkowo]" : ""}`;
          }).join(" → ")}
        </span>
        {item.definition.steps.some((step) => step.conditional) && <small className="muted">Etapy oznaczone [warunkowo] zależą od dokumentu.</small>}
      </div>
    );
  }
  if (item.source === "RULES" && item.rules) {
    return (
      <div className="overview-path">
        <span><Badge tone="info">Reguły warunkowe</Badge></span>
        {item.rules.map((rule) => (
          rule.broken ? (
            <small key={rule.id} className="text-danger">
              {rule.priority}. <strong>{rule.name}</strong>: reguła jest uszkodzona. Dokumenty, które do niej dojdą, nie dadzą się złożyć. Dokładny wynik pokazuje podgląd dokumentu.
            </small>
          ) : (
            <small key={rule.id}>
              {rule.priority}. <strong>{rule.name}</strong>: {describeConditionsObject(rule.conditions)} → {rule.steps.join(" → ") || "bez etapów"}{rule.stopProcessing ? " · kończy sprawdzanie" : ""}
            </small>
          )
        ))}
        <small className="muted">Jeżeli reguły nie dadzą żadnego etapu: akceptacja przełożonego autora.</small>
      </div>
    );
  }
  return <span><Badge tone="neutral">Wbudowany</Badge> Akceptacja przełożonego autora</span>;
}

function SchemaTab({ types }: { types: DocumentType[] }) {
  const roles = useRoles();
  const overview = useQuery({ queryKey: ["workflow-overview"], queryFn: () => apiRequest<WorkflowOverviewItem[]>("/rules/workflow-overview") });
  const [typeId, setTypeId] = useState("");
  const roleLabel = (role?: string | null) => roles.data?.find((item) => item.role === role)?.label ?? role ?? undefined;
  const selected = overview.data?.find((item) => item.type.id === typeId);

  if (overview.isPending) return <Card title="Schematy typów"><Loading /></Card>;
  if (overview.error) return <Banner tone="danger" title="Nie udało się wczytać schematów">{errorText(overview.error)}</Banner>;
  if (selected) return <TypeSchema item={selected} types={types} roleLabel={roleLabel} onBack={() => setTypeId("")} />;

  const rows = overview.data ?? [];
  return (
    <Card title="Schematy typów">
      <p className="muted small">Ścieżka, którą przejdzie nowy dokument każdego typu. Dokładną ścieżkę konkretnego dokumentu autor widzi przed złożeniem.</p>
      {!rows.length && <EmptyState title="Brak aktywnych typów dokumentów" />}
      {categoryOrder.map((category) => {
        const inCategory = rows.filter((item) => item.type.category === category);
        if (!inCategory.length) return null;
        return (
          <section key={category} className="stack-sm">
            <h3>{categoryLabels[category] ?? category}</h3>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Typ dokumentu</th><th>Ścieżka teraz</th><th /></tr></thead>
                <tbody>
                  {inCategory.map((item) => (
                    <tr key={item.type.id}>
                      <td data-label="Typ"><strong>{item.type.name}</strong></td>
                      <td data-label="Ścieżka teraz"><CurrentPath item={item} roleLabel={roleLabel} /></td>
                      <td className="row-actions">
                        <button type="button" className="btn btn-sm" onClick={() => setTypeId(item.type.id)}>{item.source === "SCHEMA" ? "Edytuj schemat" : "Ustaw schemat"}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </Card>
  );
}

function TypeSchema({ item, types, roleLabel, onBack }: { item: WorkflowOverviewItem; types: DocumentType[]; roleLabel: (role?: string | null) => string | undefined; onBack: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const typeId = item.type.id;
  const definitions = useQuery({
    queryKey: ["definitions", typeId],
    queryFn: () => apiRequest<WorkflowDefinition[]>(`/rules/workflow-definitions?documentTypeId=${typeId}`)
  });
  // Ten sam schemat, który wybrał silnik (przegląd), a nie pierwszy aktywny z listy.
  const active = item.source === "SCHEMA" ? definitions.data?.find((definition) => definition.id === item.definition?.id) : undefined;
  const [editing, setEditing] = useState<{ name: string; steps: WorkflowStepConfig[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const typeName = types.find((type) => type.id === typeId)?.name ?? item.type.name;

  function startEditing() {
    setError(null);
    if (active) setEditing({ name: active.name, steps: active.steps.map(definitionStepToEditor) });
    // Bez schematu edycja zaczyna od tego, co działa teraz: wbudowanej akceptacji przełożonego.
    else setEditing({ name: `${typeName}: ścieżka`, steps: [newStep()] });
  }

  async function refresh() {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["definitions", typeId] }),
      client.invalidateQueries({ queryKey: ["workflow-overview"] })
    ]);
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      const payload = { name: editing.name.trim(), documentTypeId: typeId, steps: editing.steps.map(schemaStepPayload) };
      const saved = await post<{ id: string }>(active ? `/rules/workflow-definitions/${active.id}/version` : "/rules/workflow-definitions", payload);
      await post(`/rules/workflow-definitions/${saved.id}/publish`);
      await refresh();
      setEditing(null);
      toast.success("Schemat opublikowany. Trwające obiegi dokończą się według starej wersji");
    } catch (saveError) {
      setError(saveError);
    } finally {
      setBusy(false);
    }
  }

  async function deactivate() {
    if (!active) return;
    try {
      await post(`/rules/workflow-definitions/${active.id}/deactivate`);
      await refresh();
      toast.success("Schemat wyłączony. Ten typ używa teraz reguł warunkowych albo akceptacji przełożonego");
    } catch (deactivateError) {
      toast.error(errorText(deactivateError));
    }
  }

  return (
    <Card title={typeName} aside={<button type="button" className="btn btn-sm btn-ghost" onClick={onBack}>← Wszystkie typy</button>}>
      <div className="stack">
        <div><strong>Ścieżka teraz:</strong> <CurrentPath item={item} roleLabel={roleLabel} /></div>
        {definitions.isPending && <Loading />}
        {definitions.error && <ErrorBanner error={definitions.error} />}
        {definitions.data && !editing && (
          <>
            {active?.isAdvanced && (
              <Banner tone="info" title="Schemat zaawansowany">Ma etapy równoległe, kworum, warunki albo przypisania, których ten edytor nie obsługuje. Zapis tutaj by je utracił, dlatego edycja jest wyłączona.</Banner>
            )}
            <div className="form-actions form-actions-start">
              {!active?.isAdvanced && <button type="button" className="btn" onClick={startEditing}>{active ? "Edytuj schemat" : "Utwórz schemat"}</button>}
              {active && <button type="button" className="btn btn-ghost" onClick={deactivate}>Wyłącz schemat</button>}
            </div>
          </>
        )}
        {editing && (
          <div className="stack">
            <ErrorBanner error={error} />
            {item.source === "RULES" && (
              <Banner tone="warning" title="Reguły przestaną działać dla tego typu">Po publikacji nowe dokumenty tego typu przejdą tylko etapy schematu. Reguły warunkowe nadal działają dla innych typów.</Banner>
            )}
            <Field label="Nazwa schematu" required>
              <input value={editing.name} maxLength={180} onChange={(event) => setEditing({ ...editing, name: event.target.value })} />
            </Field>
            <StepsEditor people steps={editing.steps} onChange={(steps) => setEditing({ ...editing, steps })} />
            <div className="form-actions">
              <button type="button" className="btn" onClick={() => setEditing(null)} disabled={busy}>Anuluj</button>
              <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !editing.name.trim()}>{busy ? "Zapisywanie…" : "Zapisz i opublikuj"}</button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

export default function WorkflowsPage() {
  const me = useMe();
  const types = useDocumentTypes();
  const [tab, setTab] = useState<"rules" | "schemas">("schemas");

  if (!me.capabilities.configureWorkflows) return <Banner tone="danger" title="Brak dostępu">Ten widok jest dostępny dla administratora.</Banner>;

  return (
    <>
      <PageHeader title="Ścieżki akceptacji" description="Ustal, przez kogo przechodzą dokumenty. Zmiany dotyczą nowych obiegów, a nie tych już trwających." />
      <Tabs value={tab} onChange={setTab} options={[{ value: "schemas", label: "Schematy typów" }, { value: "rules", label: "Reguły warunkowe" }]} />
      {tab === "rules" ? <RulesTab types={types.data ?? []} /> : <SchemaTab types={types.data ?? []} />}
    </>
  );
}
