import { AssigneeType, WorkflowStepType } from "../../shared/domain.js";
import { parseActions, parseConditions, type RuleConditions, type RuleStepAction } from "./ruleMatcher.js";

/**
 * Skąd bierze się ścieżka akceptacji typu dokumentu. Jedno miejsce dla silnika i ekranu przeglądu,
 * żeby „Ścieżka teraz” na ekranie nie rozjechała się z tym, co silnik naprawdę zrobi.
 */

/** Wbudowana ścieżka, gdy typ nie ma schematu, a reguły nie dały żadnego etapu. */
export const DEFAULT_STAGE: RuleStepAction = {
  name: "Akceptacja przełożonego",
  stepType: WorkflowStepType.MANAGER_APPROVAL,
  assigneeType: AssigneeType.MANAGER,
  dueDays: 2,
  stageNo: 1
};

type DefinitionCandidate = {
  id: string;
  version: number;
  updatedAt: Date;
  steps: unknown[];
};

/**
 * Wybór schematu spośród opublikowanych i aktywnych definicji typu: najpierw wskazana w typie
 * (o ile ma etapy), inaczej najnowsza wersja. Kandydaci muszą być już przefiltrowani do typu.
 */
export function pickDefinition<T extends DefinitionCandidate>(defaultWorkflowId: string | null, candidates: T[]): T | null {
  if (defaultWorkflowId) {
    const preferred = candidates.find((candidate) => candidate.id === defaultWorkflowId);
    if (preferred?.steps.length) return preferred;
  }
  const sorted = [...candidates].sort((a, b) => b.version - a.version || b.updatedAt.getTime() - a.updatedAt.getTime());
  return sorted[0] ?? null;
}

type RuleCandidate = {
  id: string;
  name: string;
  priority: number;
  documentTypeId: string | null;
  conditionsJson: string;
  actionsJson: string;
  validFrom: Date | null;
  validTo: Date | null;
  isActive: boolean;
};

export type PotentialRule = {
  id: string;
  name: string;
  priority: number;
  /** Warunki poza typem i kategorią: od nich zależy, czy reguła zadziała dla konkretnego dokumentu. */
  conditions: Omit<RuleConditions, "documentTypeCodes" | "categories">;
  steps: string[];
  stopProcessing: boolean;
  /** Uszkodzony JSON: silnik odmówi złożenia dokumentom, które do tej reguły dojdą. */
  broken: boolean;
};

export type RulesSource = { kind: "RULES"; rules: PotentialRule[] } | { kind: "DEFAULT" };

/**
 * Reguły, które MOGĄ dotyczyć dokumentów tego typu dzisiaj, w kolejności sprawdzania przez silnik.
 * Czy zadziałają, zależy od kwoty, działu itd., więc dokładną ścieżkę pokazuje dopiero podgląd dokumentu.
 * Reguła bez dodatkowych warunków ze stopProcessing zatrzymuje silnik dla każdego dokumentu typu,
 * więc reguły za nią są nieosiągalne i ich nie pokazujemy. Uszkodzona reguła nie oznacza blokady
 * wszystkich dokumentów — tylko tych, które do niej dojdą.
 */
export function rulesSourceForType(type: { id: string; code: string; category: string }, rules: RuleCandidate[], now: Date): RulesSource {
  const potential: PotentialRule[] = [];
  const ordered = [...rules].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  for (const rule of ordered) {
    if (!rule.isActive) continue;
    if (rule.documentTypeId && rule.documentTypeId !== type.id) continue;
    if ((rule.validFrom && rule.validFrom > now) || (rule.validTo && rule.validTo < now)) continue;
    const conditions = parseConditions(rule.conditionsJson);
    if (!conditions) {
      // Silnik czyta warunki każdej reguły, do której dojdzie, i na uszkodzonych odmawia złożenia: dalej nie zajdzie.
      potential.push({ id: rule.id, name: rule.name, priority: rule.priority, conditions: {}, steps: [], stopProcessing: false, broken: true });
      break;
    }
    if (conditions.documentTypeCodes?.length && !conditions.documentTypeCodes.includes(type.code)) continue;
    if (conditions.categories?.length && !conditions.categories.includes(type.category)) continue;
    const { documentTypeCodes: _codes, categories: _categories, ...rest } = conditions;
    const actions = parseActions(rule.actionsJson);
    potential.push({
      id: rule.id,
      name: rule.name,
      priority: rule.priority,
      conditions: rest,
      steps: (actions?.steps ?? []).map((step) => step.name),
      stopProcessing: Boolean(actions?.stopProcessing),
      broken: !actions
    });
    const unconditional = Object.values(rest).every((value) => value === undefined || (Array.isArray(value) && value.length === 0));
    if (actions?.stopProcessing && unconditional) break;
  }
  return potential.length ? { kind: "RULES", rules: potential } : { kind: "DEFAULT" };
}

type StepShape = {
  parallelGroup: number;
  completionMode: string;
  assigneeType: string;
  entryConditionJson: string | null;
  exitConditionJson: string | null;
  assignees: Array<{ assigneeType: string; userId?: string | null; groupId?: string | null; roleId?: string | null; departmentId?: string | null }>;
};

/** Przypisanie, które edytor zachowa bez strat: sama osoba, bez grupy, roli ani działu (silnik daje grupie pierwszeństwo). */
function isPlainPerson(assignee: StepShape["assignees"][number]) {
  return assignee.assigneeType === AssigneeType.USER && Boolean(assignee.userId) && !assignee.groupId && !assignee.roleId && !assignee.departmentId;
}

/**
 * Definicja, której prosty edytor nie zachowa w całości. Lista wybranych osób (ANY/ALL) jest prosta;
 * równoległość, kworum, warunki i przypisania innych rodzajów niż osoba — nie, więc są tylko do odczytu.
 */
export function isAdvancedDefinition(steps: StepShape[]) {
  return steps.some((step) =>
    step.parallelGroup !== 1 ||
    step.completionMode === "QUORUM" ||
    (step.completionMode !== "ALL" && step.assigneeType !== AssigneeType.USER) ||
    Boolean(step.entryConditionJson) ||
    Boolean(step.exitConditionJson) ||
    (step.assignees.length > 0 && step.assigneeType !== AssigneeType.USER) ||
    step.assignees.some((assignee) => !isPlainPerson(assignee))
  );
}
