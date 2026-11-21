"use client";

import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { Field } from "@/components/ui";
import { assigneeTypeLabels, fullName } from "@/lib/format";
import { useDepartments, useRoles, useUsers } from "@/lib/queries";
import type { DirectoryUser, WorkflowStageAssigneeConfig, WorkflowStepConfig } from "@/lib/types";

/** Typ kroku wynika z przypisania: dla użytkownika to szczegół techniczny, więc go nie pytamy. */
function stepTypeFor(assigneeType: string, role?: string | null) {
  if (assigneeType === "MANAGER" || assigneeType === "DEPARTMENT_MANAGER") return "MANAGER_APPROVAL";
  if (assigneeType === "BOARD" || role === "BOARD") return "BOARD_APPROVAL";
  if (role === "ACCOUNTING") return "FINANCIAL_APPROVAL";
  if (role === "LEGAL") return "LEGAL_APPROVAL";
  return "BUSINESS_APPROVAL";
}

export function newStep(): WorkflowStepConfig {
  return {
    name: "Akceptacja przełożonego",
    stepType: "MANAGER_APPROVAL",
    assigneeType: "MANAGER",
    dueDays: 2,
    requiresComment: false,
    requiresAttachment: false,
    canDelegate: true,
    canReturn: true,
    stageKind: "DECISION"
  };
}

/** Do wiadomości można przekazać tylko przełożonemu autora albo wybranym osobom. */
const INFO_ASSIGNEE_TYPES = ["MANAGER", "USER"];

/**
 * `people`: edytor stałego schematu. Wtedy „Konkretna osoba” to lista wybranych osób (z trybem jedna / wszystkie).
 * Reguły warunkowe zapisują w JSON tylko jedną osobę, więc dla nich zostaje pojedynczy wybór.
 */
export function StepsEditor({ steps, onChange, people = false }: { steps: WorkflowStepConfig[]; onChange: (steps: WorkflowStepConfig[]) => void; people?: boolean }) {
  const roles = useRoles();
  const users = useUsers();
  const departments = useDepartments();

  function update(index: number, patch: Partial<WorkflowStepConfig>) {
    onChange(steps.map((step, position) => {
      if (position !== index) return step;
      const next = { ...step, ...patch };
      return { ...next, stepType: stepTypeFor(next.assigneeType, next.assigneeRole) };
    }));
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  return (
    <div className="stack">
      {steps.map((step, index) => {
        const needsRole = step.assigneeType === "ROLE" || step.assigneeType === "DEPARTMENT_ROLE";
        const isInfo = people && step.stageKind === "INFO";
        return (
          <fieldset key={index} className="step-card">
            <legend>Etap {index + 1}</legend>
            <div className="step-tools">
              <button type="button" className="icon-btn" aria-label="Przesuń wyżej" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={16} /></button>
              <button type="button" className="icon-btn" aria-label="Przesuń niżej" disabled={index === steps.length - 1} onClick={() => move(index, 1)}><ArrowDown size={16} /></button>
              <button type="button" className="icon-btn" aria-label="Usuń etap" disabled={steps.length === 1} onClick={() => onChange(steps.filter((_, position) => position !== index))}><Trash2 size={16} /></button>
            </div>
            <div className="form-grid">
              <Field label="Nazwa etapu" required wide>
                <input value={step.name} maxLength={180} onChange={(event) => update(index, { name: event.target.value })} required />
              </Field>
              {people && (
                <Field label="Rodzaj etapu" required hint={isInfo ? "Dokument trafia do wiadomości, a obieg idzie dalej bez czekania." : undefined}>
                  <select
                    value={isInfo ? "INFO" : "DECISION"}
                    onChange={(event) => {
                      const info = event.target.value === "INFO";
                      const keepAssignee = !info || INFO_ASSIGNEE_TYPES.includes(step.assigneeType);
                      update(index, {
                        stageKind: event.target.value,
                        ...(info ? { requiresComment: false, requiresAttachment: false, completionMode: "ALL" } : {}),
                        ...(keepAssignee ? {} : { assigneeType: "MANAGER", assigneeRole: null, assigneeUserId: null, assigneeDepartmentId: null, userIds: undefined })
                      });
                    }}
                  >
                    <option value="DECISION">Decyzja (akceptuj / odrzuć / zwróć)</option>
                    <option value="INFO">Do wiadomości (bez decyzji)</option>
                  </select>
                </Field>
              )}
              <Field label={isInfo ? "Kto otrzymuje?" : "Kto decyduje?"} required>
                <select
                  value={step.assigneeType}
                  // Zmiana rodzaju czyści poprzednich adresatów: żadnych ukrytych przypisań w zapisie.
                  onChange={(event) => update(index, {
                    assigneeType: event.target.value,
                    assigneeRole: null,
                    assigneeUserId: null,
                    assigneeDepartmentId: null,
                    userIds: people && event.target.value === "USER" ? [] : undefined,
                    completionMode: people ? "ALL" : undefined
                  })}
                >
                  {Object.entries(assigneeTypeLabels)
                    .filter(([value]) => !isInfo || INFO_ASSIGNEE_TYPES.includes(value))
                    .map(([value, label]) => <option key={value} value={value}>{value === "USER" && people ? "Wybrane osoby" : label}</option>)}
                </select>
              </Field>
              {needsRole && (
                <Field label="Rola" required>
                  <select value={step.assigneeRole ?? ""} onChange={(event) => update(index, { assigneeRole: event.target.value || null })} required>
                    <option value="">Wybierz rolę…</option>
                    {(roles.data ?? []).map((role) => <option key={role.role} value={role.role}>{role.label}</option>)}
                  </select>
                </Field>
              )}
              {step.assigneeType === "DEPARTMENT_ROLE" && (
                <Field label="Dział" hint="Puste: dział autora.">
                  <select value={step.assigneeDepartmentId ?? ""} onChange={(event) => update(index, { assigneeDepartmentId: event.target.value || null })}>
                    <option value="">Dział autora</option>
                    {(departments.data ?? []).map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
                  </select>
                </Field>
              )}
              {step.assigneeType === "USER" && people && (
                <PeoplePicker step={step} info={isInfo} users={(users.data ?? []).filter((user) => user.isActive)} onChange={(patch) => update(index, patch)} />
              )}
              {step.assigneeType === "USER" && !people && (
                <Field label="Osoba" required>
                  <select value={step.assigneeUserId ?? ""} onChange={(event) => update(index, { assigneeUserId: event.target.value || null })} required>
                    <option value="">Wybierz osobę…</option>
                    {(users.data ?? []).filter((user) => user.isActive).map((user) => <option key={user.id} value={user.id}>{fullName(user)}</option>)}
                  </select>
                </Field>
              )}
              {!isInfo && (
                <Field label="Dni na decyzję" required>
                  <input type="number" min={1} max={365} value={step.dueDays} onChange={(event) => update(index, { dueDays: Number(event.target.value) || 1 })} />
                </Field>
              )}
            </div>
            {!isInfo && <div className="check-row">
              <label className="check"><input type="checkbox" checked={step.requiresComment} onChange={(event) => update(index, { requiresComment: event.target.checked })} />Komentarz obowiązkowy</label>
              <label className="check"><input type="checkbox" checked={step.requiresAttachment} onChange={(event) => update(index, { requiresAttachment: event.target.checked })} />Wymagany załącznik</label>
              <label className="check"><input type="checkbox" checked={step.canDelegate} onChange={(event) => update(index, { canDelegate: event.target.checked })} />Można przekazać</label>
              <label className="check"><input type="checkbox" checked={step.canReturn} onChange={(event) => update(index, { canReturn: event.target.checked })} />Można zwrócić do poprawy</label>
            </div>}
          </fieldset>
        );
      })}
      <div>
        <button type="button" className="btn btn-sm" onClick={() => onChange([...steps, newStep()])}><Plus size={14} />Dodaj etap</button>
      </div>
    </div>
  );
}

function PeoplePicker({ step, users, info, onChange }: { step: WorkflowStepConfig; users: DirectoryUser[]; info: boolean; onChange: (patch: Partial<WorkflowStepConfig>) => void }) {
  const selected = step.userIds ?? [];
  const byId = new Map(users.map((user) => [user.id, user]));
  return (
    <Field label="Osoby" required wide hint={info ? "Autor dokumentu jest pomijany. Osoba z nieaktywnym kontem nie dostanie informacji." : "Autor dokumentu jest pomijany. Gdy był jedyną osobą, decyduje jego przełożony."}>
      <div className="stack-sm">
        {selected.length > 0 && (
          <ul className="people-list">
            {selected.map((userId) => (
              <li key={userId}>
                <span>{byId.get(userId) ? fullName(byId.get(userId)!) : "Nieaktywna lub nieznana osoba"}</span>
                <button type="button" className="icon-btn" aria-label="Usuń osobę" onClick={() => onChange({ userIds: selected.filter((id) => id !== userId) })}><X size={14} /></button>
              </li>
            ))}
          </ul>
        )}
        <select
          aria-label="Dodaj osobę"
          value=""
          onChange={(event) => event.target.value && onChange({ userIds: [...selected, event.target.value] })}
        >
          <option value="">{selected.length ? "Dodaj kolejną osobę…" : "Wybierz osobę…"}</option>
          {users.filter((user) => !selected.includes(user.id)).map((user) => <option key={user.id} value={user.id}>{fullName(user)}</option>)}
        </select>
        {selected.length > 1 && !info && (
          <select aria-label="Ile decyzji potrzeba" value={step.completionMode === "ANY" ? "ANY" : "ALL"} onChange={(event) => onChange({ completionMode: event.target.value })}>
            <option value="ALL">Potrzebna decyzja wszystkich wybranych osób (poza autorem)</option>
            <option value="ANY">Wystarczy decyzja jednej osoby</option>
          </select>
        )}
        {selected.length > 1 && !info && <small className="muted">Odrzucenie przez którąkolwiek osobę zatrzymuje obieg.</small>}
      </div>
    </Field>
  );
}

/** Kroki stałego schematu z API → stan edytora: osoby z listy przypisań albo z pojedynczego pola. */
export function definitionStepToEditor(step: WorkflowStepConfig & { completionMode?: string; assignees?: WorkflowStageAssigneeConfig[] }): WorkflowStepConfig {
  const { id: _id, ...rest } = step as WorkflowStepConfig & { id?: string; assignees?: WorkflowStageAssigneeConfig[] };
  const userIds = step.assigneeType === "USER"
    ? (step.assignees?.length ? step.assignees.flatMap((assignee) => (assignee.userId ? [assignee.userId] : [])) : step.assigneeUserId ? [step.assigneeUserId] : [])
    : undefined;
  return {
    ...newStep(),
    name: rest.name,
    stepType: rest.stepType,
    assigneeType: rest.assigneeType,
    assigneeRole: rest.assigneeRole ?? null,
    assigneeUserId: null,
    assigneeDepartmentId: rest.assigneeDepartmentId ?? null,
    dueDays: rest.dueDays,
    requiresComment: rest.requiresComment,
    requiresAttachment: rest.requiresAttachment,
    canDelegate: rest.canDelegate,
    canReturn: rest.canReturn,
    userIds,
    completionMode: step.completionMode === "ANY" ? "ANY" : "ALL",
    stageKind: step.stageKind === "INFO" ? "INFO" : "DECISION"
  };
}

/** Etap stałego schematu dla API: wybrane osoby jako lista przypisań, bez pozostałości po innych rodzajach. */
export function schemaStepPayload(step: WorkflowStepConfig, index: number) {
  const info = step.stageKind === "INFO";
  // Etap „do wiadomości” nie ma decyzji: pola decyzji wysyłamy wyzerowane (serwer i tak je sprawdza).
  const base = { ...stepPayload(step, index), stageKind: info ? "INFO" : "DECISION", ...(info ? { requiresComment: false, requiresAttachment: false, canDelegate: false, canReturn: false } : {}) };
  if (step.assigneeType !== "USER") return { ...base, completionMode: "ALL" };
  const userIds = step.userIds ?? [];
  return {
    ...base,
    assigneeUserId: null,
    completionMode: !info && userIds.length > 1 && step.completionMode === "ANY" ? "ANY" : "ALL",
    assignees: userIds.map((userId) => ({ assigneeType: "USER", userId }))
  };
}

/** Pola etapu dla API: bez `undefined` i bez identyfikatorów starej wersji. */
export function stepPayload(step: WorkflowStepConfig, index: number) {
  return {
    name: step.name.trim(),
    stepType: step.stepType,
    order: index + 1,
    assigneeType: step.assigneeType,
    assigneeRole: step.assigneeRole || null,
    assigneeUserId: step.assigneeUserId || null,
    assigneeDepartmentId: step.assigneeDepartmentId || null,
    dueDays: step.dueDays,
    requiresComment: step.requiresComment,
    requiresAttachment: step.requiresAttachment,
    canDelegate: step.canDelegate,
    canReturn: step.canReturn
  };
}
