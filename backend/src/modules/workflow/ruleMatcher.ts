import type { Document, DocumentType } from "@prisma/client";
import { z } from "zod";
import { AssigneeType, StageKind, SystemRole, WorkflowStepType } from "../../shared/domain.js";

/**
 * Schemat warunków reguły. `strict`, bo literówka w nazwie warunku bez niego dawałaby
 * regułę pasującą do wszystkiego, czyli nieoczekiwaną ścieżkę akceptacji.
 */
export const ruleConditionsSchema = z.object({
  documentTypeCodes: z.array(z.string()).optional(),
  categories: z.array(z.string()).optional(),
  amountMin: z.number().min(0).optional(),
  amountMax: z.number().min(0).optional(),
  currency: z.string().length(3).optional(),
  currencies: z.array(z.string().length(3)).optional(),
  departmentCodes: z.array(z.string()).optional(),
  location: z.string().optional(),
  keywords: z.array(z.string()).optional()
}).strict();

export type RuleConditions = z.infer<typeof ruleConditionsSchema>;

export const ruleStepSchema = z.object({
  name: z.string().trim().min(1).max(180),
  stepType: z.nativeEnum(WorkflowStepType).default(WorkflowStepType.BUSINESS_APPROVAL),
  stageKind: z.nativeEnum(StageKind).optional(),
  assigneeType: z.nativeEnum(AssigneeType),
  assigneeRole: z.nativeEnum(SystemRole).optional(),
  assigneeUserId: z.string().optional(),
  assigneeDepartmentId: z.string().optional(),
  dueDays: z.number().int().min(1).max(365).optional(),
  requiresComment: z.boolean().optional(),
  requiresAttachment: z.boolean().optional(),
  canDelegate: z.boolean().optional(),
  canReturn: z.boolean().optional()
}).strict().superRefine((step, ctx) => {
  if ((step.assigneeType === AssigneeType.ROLE || step.assigneeType === AssigneeType.DEPARTMENT_ROLE) && !step.assigneeRole) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["assigneeRole"], message: "Wybierz rolę akceptującą" });
  }
  if (step.assigneeType === AssigneeType.USER && !step.assigneeUserId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["assigneeUserId"], message: "Wybierz osobę akceptującą" });
  }
  if (step.stageKind === StageKind.INFO && step.assigneeType !== AssigneeType.USER && step.assigneeType !== AssigneeType.MANAGER) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["assigneeType"], message: "Do wiadomości można przekazać tylko wybranej osobie albo przełożonemu autora" });
  }
});

export const ruleActionsSchema = z.object({
  stopProcessing: z.boolean().optional(),
  steps: z.array(ruleStepSchema).optional()
}).strict();

export type RuleStepAction = {
  name: string;
  stepType: string;
  stageKind?: string;
  assigneeType: string;
  assigneeRole?: string;
  assigneeUserId?: string;
  assigneeDepartmentId?: string;
  dueDays?: number;
  requiresComment?: boolean;
  requiresAttachment?: boolean;
  canDelegate?: boolean;
  canReturn?: boolean;
  allowSelfApproval?: boolean;
  stepId?: string;
  stageNo?: number;
  parallelGroup?: number;
  completionMode?: "ALL" | "ANY" | "QUORUM";
  requiredApprovals?: number;
  rejectMode?: string;
  entryConditionJson?: string;
  exitConditionJson?: string;
};

export type RuleActions = {
  stopProcessing?: boolean;
  steps?: RuleStepAction[];
};

type MatchableDocument = Pick<Document, "amount" | "currency" | "title" | "location"> & {
  type: Pick<DocumentType, "code" | "category">;
  department?: { code: string } | null;
};

function parseJson(raw: string) {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Warunki reguły albo `null`, gdy konfiguracja jest uszkodzona. Pusty obiekt dawniej
 * oznaczał „pasuje do wszystkiego”, więc błędna reguła trafiała w każdy dokument.
 * Decyzję, co zrobić z `null`, podejmuje silnik: odmawia złożenia zamiast zgadywać.
 */
export function parseConditions(raw: string | null | undefined): RuleConditions | null {
  if (!raw) return {};
  const result = ruleConditionsSchema.safeParse(parseJson(raw));
  return result.success ? result.data : null;
}

export function parseActions(raw: string | null | undefined): RuleActions | null {
  if (!raw) return {};
  const result = ruleActionsSchema.safeParse(parseJson(raw));
  return result.success ? result.data : null;
}

export function matchesRuleConditions(conditions: RuleConditions, document: MatchableDocument): boolean {
  const amount = document.amount === null || document.amount === undefined ? undefined : Number(document.amount);

  if (conditions.documentTypeCodes?.length && !conditions.documentTypeCodes.includes(document.type.code)) {
    return false;
  }

  if (conditions.categories?.length && !conditions.categories.includes(document.type.category)) {
    return false;
  }

  if (conditions.currency && document.currency !== conditions.currency) {
    return false;
  }

  if (conditions.currencies?.length && !conditions.currencies.includes(document.currency)) {
    return false;
  }

  if (conditions.departmentCodes?.length && !conditions.departmentCodes.includes(document.department?.code ?? "")) {
    return false;
  }

  if (conditions.location && document.location !== conditions.location) {
    return false;
  }

  if (conditions.amountMin !== undefined && (amount === undefined || amount < conditions.amountMin)) {
    return false;
  }

  if (conditions.amountMax !== undefined && (amount === undefined || amount > conditions.amountMax)) {
    return false;
  }

  if (conditions.keywords?.length) {
    const haystack = document.title.toLocaleLowerCase("pl-PL");
    const hasKeyword = conditions.keywords.some((keyword) =>
      haystack.includes(keyword.toLocaleLowerCase("pl-PL"))
    );
    if (!hasKeyword) {
      return false;
    }
  }

  return true;
}
