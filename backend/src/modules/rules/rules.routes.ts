import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z, type ZodTypeAny } from "zod";
import { authenticate, requireCapability } from "../../middleware/auth.js";
import { AppError, asyncHandler, requireParam } from "../../shared/http.js";
import { prisma } from "../../shared/prisma.js";
import { requestAuditContext, writeAuditInTransaction } from "../../shared/audit.js";
import { serializableTransaction } from "../../shared/transactions.js";
import { SystemRole, WorkflowStepType, AssigneeType, StageKind } from "../../shared/domain.js";
import { ruleActionsSchema, ruleConditionsSchema } from "../workflow/ruleMatcher.js";
import { isAdvancedDefinition, pickDefinition, rulesSourceForType } from "../workflow/workflowSource.js";
import { canDecideTasks } from "../../shared/roles.js";

export const rulesRouter = Router();

const approvalRuleSchema = z.object({
  name: z.string().trim().min(1).max(180),
  priority: z.number().int().default(100),
  documentTypeId: z.string().optional().nullable(),
  conditionsJson: z.string().default("{}"),
  actionsJson: z.string().default("{}"),
  validFrom: z.coerce.date().optional().nullable(),
  validTo: z.coerce.date().optional().nullable(),
  isActive: z.boolean().default(true)
});

const stageAssigneeSchema = z.object({
  assigneeType: z.nativeEnum(AssigneeType),
  userId: z.string().optional().nullable(),
  roleId: z.string().optional().nullable(),
  groupId: z.string().optional().nullable(),
  departmentId: z.string().optional().nullable()
});

const workflowStepSchema = z.object({
  name: z.string().trim().min(1).max(180),
  stepType: z.nativeEnum(WorkflowStepType),
  stageKind: z.nativeEnum(StageKind).default(StageKind.DECISION),
  order: z.number().int(),
  stageNo: z.number().int().positive().optional(),
  parallelGroup: z.number().int().positive().default(1),
  completionMode: z.enum(["ALL", "ANY", "QUORUM"]).default("ALL"),
  requiredApprovals: z.number().int().positive().default(1),
  // Silnik zna tylko zatrzymanie obiegu. Inne tryby były przyjmowane i ignorowane.
  rejectMode: z.literal("STOP").default("STOP"),
  assigneeType: z.nativeEnum(AssigneeType),
  assigneeRole: z.nativeEnum(SystemRole).optional().nullable(),
  assigneeUserId: z.string().optional().nullable(),
  assigneeDepartmentId: z.string().optional().nullable(),
  dueDays: z.number().int().min(1).max(365).default(2),
  requiresComment: z.boolean().default(false),
  requiresAttachment: z.boolean().default(false),
  canDelegate: z.boolean().default(true),
  canReturn: z.boolean().default(true),
  entryConditionJson: z.string().optional().nullable(),
  exitConditionJson: z.string().optional().nullable(),
  assignees: z.array(stageAssigneeSchema).optional()
});

const workflowDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(180),
  documentTypeId: z.string().optional().nullable(),
  // `version` nie jest tu przyjmowane — numer nadaje serwer w transakcji.
  isActive: z.boolean().default(true),
  steps: z.array(workflowStepSchema).min(1, "Dodaj co najmniej jeden etap")
}).superRefine((input, ctx) => {
  const stageKeys = new Set<string>();
  // Ścieżka z samych etapów „do wiadomości” zatwierdzałaby dokument bez decyzji człowieka.
  if (!input.steps.some((step) => step.stageKind === StageKind.DECISION)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: "Schemat musi mieć co najmniej jeden etap decyzji" });
  }
  const kindsByStage = new Map<number, Set<string>>();
  input.steps.forEach((step, index) => {
    const stageNo = step.stageNo ?? index + 1;
    kindsByStage.set(stageNo, (kindsByStage.get(stageNo) ?? new Set()).add(step.stageKind));
    if (step.stageKind === StageKind.INFO) {
      // Każdy adresat, także zagnieżdżony, musi być osobą albo przełożonym autora. Innych silnik by nie doręczył.
      const nestedOk = (step.assignees ?? []).every((assignee) => assignee.assigneeType === AssigneeType.USER && assignee.userId && !assignee.groupId && !assignee.roleId && !assignee.departmentId);
      const topOk = step.assigneeType === AssigneeType.MANAGER ? !step.assignees?.length : step.assigneeType === AssigneeType.USER;
      if (!topOk || !nestedOk) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index, "assigneeType"], message: `Etap „${step.name}”: do wiadomości można przekazać tylko wybranym osobom albo przełożonemu autora` });
      }
      if (step.completionMode !== "ALL" || step.requiresComment || step.requiresAttachment || step.entryConditionJson || step.exitConditionJson) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index], message: `Etap „${step.name}”: etap do wiadomości nie ma decyzji, komentarza, załącznika ani warunków` });
      }
    }
    const key = `${step.stageNo ?? index + 1}:${step.parallelGroup}`;
    if (stageKeys.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index], message: "Numer etapu i grupa równoległa muszą być unikalne" });
    stageKeys.add(key);
    const approverCount = step.assignees?.length ?? 1;
    if (step.completionMode === "QUORUM" && step.requiredApprovals > approverCount) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index, "requiredApprovals"], message: "Wymagana liczba decyzji przekracza liczbę osób" });
    }
    const userIds = (step.assignees ?? []).filter((assignee) => assignee.assigneeType === AssigneeType.USER).map((assignee) => assignee.userId);
    if ((step.assignees ?? []).some((assignee) => assignee.assigneeType === AssigneeType.USER && (assignee.groupId || assignee.roleId || assignee.departmentId))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index, "assignees"], message: `Etap „${step.name}”: osoba nie może mieć jednocześnie grupy, roli ani działu` });
    }
    if (userIds.some((userId) => !userId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index, "assignees"], message: `Etap „${step.name}”: wybierz osobę` });
    }
    if (new Set(userIds).size !== userIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index, "assignees"], message: `Etap „${step.name}”: ta sama osoba jest wybrana dwa razy` });
    }
    if (!step.assignees?.length) {
      if ((step.assigneeType === AssigneeType.ROLE || step.assigneeType === AssigneeType.DEPARTMENT_ROLE) && !step.assigneeRole) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index, "assigneeRole"], message: `Etap „${step.name}”: wybierz rolę` });
      }
      if (step.assigneeType === AssigneeType.USER && !step.assigneeUserId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index, "assigneeUserId"], message: `Etap „${step.name}”: wybierz osobę` });
      }
    }
    for (const json of [step.entryConditionJson, step.exitConditionJson]) {
      if (json && !ruleConditionsSchema.safeParse(parseOrUndefined(json)).success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index], message: `Etap „${step.name}”: warunek jest niepoprawny` });
      }
    }
  });
  for (const [stageNo, kinds] of kindsByStage) {
    if (kinds.size > 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: `Etap ${stageNo}: decyzja i „do wiadomości” nie mogą być w tym samym etapie równoległym` });
  }
});

function parseOrUndefined(raw: string) {
  try { return JSON.parse(raw) as unknown; } catch { return undefined; }
}

function stepCreateData(step: z.infer<typeof workflowStepSchema>, index: number) {
  return {
    name: step.name,
    stepType: step.stepType,
    stageKind: step.stageKind,
    order: index + 1,
    stageNo: step.stageNo ?? index + 1,
    parallelGroup: step.parallelGroup,
    completionMode: step.completionMode,
    requiredApprovals: step.requiredApprovals,
    rejectMode: step.rejectMode,
    assigneeType: step.assigneeType,
    assigneeRole: step.assigneeRole ?? undefined,
    assigneeUserId: step.assigneeUserId ?? undefined,
    assigneeDepartmentId: step.assigneeDepartmentId ?? undefined,
    dueDays: step.dueDays,
    requiresComment: step.requiresComment,
    requiresAttachment: step.requiresAttachment,
    // Etap „do wiadomości” nie ma zadania, więc nie da się go przekazać ani z niego zwrócić.
    canDelegate: step.stageKind === StageKind.INFO ? false : step.canDelegate,
    canReturn: step.stageKind === StageKind.INFO ? false : step.canReturn,
    entryConditionJson: step.entryConditionJson ?? undefined,
    exitConditionJson: step.exitConditionJson ?? undefined,
    assignees: step.assignees?.length ? { create: step.assignees.map((assignee, sortOrder) => ({ ...assignee, sortOrder })) } : undefined
  };
}

/**
 * Kolejny numer wersji definicji dla danego typu dokumentu.
 * Musi być liczony w tej samej transakcji co insert — inaczej dwa równoległe
 * żądania dostają ten sam numer i łamią @@unique([documentTypeId, version]).
 */
async function nextWorkflowVersion(tx: Prisma.TransactionClient, documentTypeId: string | null) {
  const latest = await tx.workflowDefinition.findFirst({
    where: { documentTypeId },
    orderBy: { version: "desc" }
  });
  return (latest?.version ?? 0) + 1;
}

/** Zamienia kolizję unikalności wersji w czytelny konflikt zamiast 500. */
function rethrowVersionConflict(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw new AppError(409, "Inna wersja definicji obiegu dla tego typu dokumentu została właśnie zapisana. Spróbuj ponownie.");
  }
  throw error;
}

/**
 * Sprawdza JSON z pola tekstowego: składnię, a gdy podano schemat, także strukturę.
 * Sama składnia nie wystarcza: `null` albo `{"steps":{}}` to poprawny JSON, który po
 * zapisaniu wywracał składanie każdego pasującego dokumentu.
 */
export function assertValidJson(value: string | undefined, field: string, schema?: ZodTypeAny) {
  if (value === undefined) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new AppError(400, `Pole ${field} musi zawierać poprawny JSON`, {
      issues: [{ field, message: error instanceof Error ? error.message : "Nieprawidłowy JSON" }]
    });
  }
  const result = schema?.safeParse(parsed);
  if (result && !result.success) {
    throw new AppError(400, `Pole ${field} ma niepoprawną strukturę`, {
      issues: result.error.issues.map((issue) => ({ field: `${field}.${issue.path.join(".")}`, message: issue.message }))
    });
  }
}

function assertRuleConfiguration(input: { conditionsJson?: string; actionsJson?: string }) {
  assertValidJson(input.conditionsJson, "conditionsJson", ruleConditionsSchema);
  assertValidJson(input.actionsJson, "actionsJson", ruleActionsSchema);
}

/**
 * Wybrane osoby muszą móc decydować już przy publikacji. Kwotę i autora zna dopiero konkretny dokument,
 * więc to sprawdza silnik przy złożeniu; tu łapiemy błąd konfiguracji, zanim trafi na pierwszy wniosek.
 */
async function assertSelectedPeopleCanDecide(
  tx: Prisma.TransactionClient,
  steps: Array<{ name: string; stageKind: string; assigneeType: string; assigneeUserId: string | null; assignees: Array<{ assigneeType: string; userId: string | null }> }>
) {
  const wanted = steps.flatMap((step) => {
    const decides = step.stageKind !== StageKind.INFO;
    return [
      ...(step.assigneeType === AssigneeType.USER && step.assigneeUserId ? [{ step: step.name, userId: step.assigneeUserId, decides }] : []),
      ...step.assignees.filter((assignee) => assignee.assigneeType === AssigneeType.USER && assignee.userId).map((assignee) => ({ step: step.name, userId: assignee.userId!, decides }))
    ];
  });
  if (!wanted.length) return;
  const users = await tx.user.findMany({ where: { id: { in: [...new Set(wanted.map((item) => item.userId))] } }, select: { id: true, firstName: true, lastName: true, isActive: true, role: true } });
  const byId = new Map(users.map((user) => [user.id, user]));
  const issues = wanted.flatMap(({ step, userId, decides }) => {
    const user = byId.get(userId);
    if (!user) return [{ field: step, message: `Etap „${step}”: wybrana osoba nie istnieje` }];
    if (!user.isActive) return [{ field: step, message: `Etap „${step}”: ${user.firstName} ${user.lastName} ma nieaktywne konto` }];
    // Odbiorca „do wiadomości” niczego nie decyduje, więc wystarczy aktywne konto.
    if (decides && !canDecideTasks(user.role)) return [{ field: step, message: `Etap „${step}”: ${user.firstName} ${user.lastName} ma rolę bez prawa decyzji` }];
    return [];
  });
  if (issues.length) throw new AppError(400, issues[0].message, { issues });
}

rulesRouter.use(authenticate, requireCapability("configureWorkflows"));

rulesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rules = await prisma.approvalRule.findMany({
      include: { documentType: { select: { id: true, name: true, code: true } } },
      orderBy: [{ priority: "asc" }, { name: "asc" }]
    });
    res.json(rules);
  })
);

rulesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = approvalRuleSchema.parse(req.body);
    assertRuleConfiguration(input);
    const rule = await prisma.$transaction(async (tx) => {
      const created = await tx.approvalRule.create({ data: input });
      await writeAuditInTransaction(tx, {
        userId: req.user!.id,
        entityType: "APPROVAL_RULE",
        entityId: created.id,
        action: "CREATE",
        after: created,
        ...requestAuditContext(req)
      });
      return created;
    });
    res.status(201).json(rule);
  })
);

rulesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    // `partial` zachowałby wartości domyślne schematu i nadpisał pola, których nie wysłano.
    const input = approvalRuleSchema.partial().parse(req.body);
    const provided = Object.fromEntries(Object.entries(input).filter(([key]) => key in (req.body as object)));
    assertRuleConfiguration(provided);
    const rule = await prisma.$transaction(async (tx) => {
      const before = await tx.approvalRule.findUnique({ where: { id } });
      if (!before) throw new AppError(404, "Nie znaleziono reguły");
      const updated = await tx.approvalRule.update({ where: { id }, data: provided });
      await writeAuditInTransaction(tx, {
        userId: req.user!.id,
        entityType: "APPROVAL_RULE",
        entityId: id,
        action: "UPDATE",
        before,
        after: updated,
        ...requestAuditContext(req)
      });
      return updated;
    });
    res.json(rule);
  })
);

/**
 * Ścieżka każdego aktywnego typu: schemat, reguły, które mogą go dotyczyć, albo wbudowana akceptacja
 * przełożonego. Wybór źródła jest ten sam co w silniku (workflowSource.ts).
 */
rulesRouter.get(
  "/workflow-overview",
  asyncHandler(async (_req, res) => {
    const now = new Date();
    const [types, definitions, rules] = await Promise.all([
      prisma.documentType.findMany({
        where: { isActive: true },
        select: { id: true, name: true, code: true, category: true, defaultWorkflowId: true },
        orderBy: [{ category: "asc" }, { name: "asc" }]
      }),
      prisma.workflowDefinition.findMany({
        where: { isActive: true, status: "PUBLISHED", documentTypeId: { not: null } },
        include: {
          steps: {
            include: { assignees: { include: { user: { select: { firstName: true, lastName: true } }, role: { select: { name: true } } } }, assigneeUser: { select: { firstName: true, lastName: true } } },
            orderBy: [{ stageNo: "asc" }, { parallelGroup: "asc" }, { order: "asc" }]
          }
        }
      }),
      prisma.approvalRule.findMany({ where: { isActive: true } })
    ]);
    const fullName = (user: { firstName: string; lastName: string } | null) => (user ? `${user.firstName} ${user.lastName}` : "Nieznana osoba");
    res.json(types.map((type) => {
      const definition = pickDefinition(type.defaultWorkflowId, definitions.filter((item) => item.documentTypeId === type.id));
      const base = { type: { id: type.id, name: type.name, code: type.code, category: type.category } };
      if (definition?.steps.length) {
        return {
          ...base,
          source: "SCHEMA" as const,
          definition: {
            id: definition.id,
            name: definition.name,
            version: definition.version,
            isAdvanced: isAdvancedDefinition(definition.steps),
            steps: definition.steps.map((step) => ({
              name: step.name,
              stageNo: step.stageNo,
              stageKind: step.stageKind,
              assigneeType: step.assigneeType,
              assigneeRole: step.assigneeRole,
              completionMode: step.completionMode,
              conditional: Boolean(step.entryConditionJson),
              people: step.assignees.length
                ? step.assignees.map((assignee) => (assignee.userId ? fullName(assignee.user) : assignee.role?.name ?? assignee.assigneeType))
                : step.assigneeUserId ? [fullName(step.assigneeUser)] : []
            }))
          }
        };
      }
      const rulesSource = rulesSourceForType(type, rules, now);
      if (rulesSource.kind === "RULES") return { ...base, source: "RULES" as const, rules: rulesSource.rules };
      return { ...base, source: "DEFAULT" as const };
    }));
  })
);

rulesRouter.get(
  "/workflow-definitions",
  asyncHandler(async (req, res) => {
    const where =
      typeof req.query.documentTypeId === "string"
        ? { documentTypeId: req.query.documentTypeId || null }
        : {};
    const definitions = await prisma.workflowDefinition.findMany({
      where,
      include: {
        documentType: { select: { id: true, name: true, code: true } },
        steps: { orderBy: { order: "asc" }, include: { assignees: true } }
      },
      orderBy: [{ isActive: "desc" }, { version: "desc" }, { name: "asc" }]
    });
    res.json(definitions.map((definition) => ({ ...definition, isAdvanced: isAdvancedDefinition(definition.steps) })));
  })
);

async function createDraftDefinition(
  input: z.infer<typeof workflowDefinitionSchema>,
  documentTypeId: string | null,
  auditAction: string,
  auditContext: ReturnType<typeof requestAuditContext> & { userId: string }
) {
  return serializableTransaction(async (tx) => {
    // Numer wersji nadaje serwer. Wartość z żądania kolidowała z istniejącymi
    // wersjami tego typu (@@unique([documentTypeId, version])) i kończyła się 500.
    const created = await tx.workflowDefinition.create({
      data: {
        name: input.name,
        documentTypeId: documentTypeId ?? undefined,
        version: await nextWorkflowVersion(tx, documentTypeId),
        status: "DRAFT",
        isActive: false,
        steps: { create: input.steps.map(stepCreateData) }
      },
      include: { documentType: { select: { id: true, name: true, code: true } }, steps: { orderBy: { order: "asc" } } }
    });
    await writeAuditInTransaction(tx, {
      ...auditContext,
      entityType: "WORKFLOW_DEFINITION",
      entityId: created.id,
      action: auditAction,
      after: { version: created.version }
    });
    return created;
  }).catch(rethrowVersionConflict);
}

rulesRouter.post(
  "/workflow-definitions",
  asyncHandler(async (req, res) => {
    const input = workflowDefinitionSchema.parse(req.body);
    const definition = await createDraftDefinition(input, input.documentTypeId ?? null, "DRAFT_CREATED", { userId: req.user!.id, ...requestAuditContext(req) });
    res.status(201).json(definition);
  })
);

rulesRouter.post(
  "/workflow-definitions/:id/version",
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    const input = workflowDefinitionSchema.parse(req.body);
    const before = await prisma.workflowDefinition.findUnique({ where: { id } });
    if (!before) throw new AppError(404, "Nie znaleziono definicji obiegu");
    const documentTypeId = input.documentTypeId ?? before.documentTypeId ?? null;
    const definition = await createDraftDefinition(input, documentTypeId, "DRAFT_VERSION_CREATED", { userId: req.user!.id, ...requestAuditContext(req) });
    res.status(201).json(definition);
  })
);

rulesRouter.post(
  "/workflow-definitions/:id/publish",
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    const definition = await serializableTransaction(async (tx) => {
      const draft = await tx.workflowDefinition.findUnique({ where: { id }, include: { steps: { include: { assignees: true } } } });
      if (!draft) throw new AppError(404, "Nie znaleziono definicji obiegu");
      if (draft.status !== "DRAFT") throw new AppError(409, "Opublikować można tylko wersję roboczą");
      if (!draft.steps.length) throw new AppError(400, "Obieg musi mieć co najmniej jeden etap");
      await assertSelectedPeopleCanDecide(tx, draft.steps);
      await tx.workflowDefinition.updateMany({
        where: { documentTypeId: draft.documentTypeId, isActive: true },
        data: { isActive: false }
      });
      const published = await tx.workflowDefinition.update({
        where: { id },
        data: { status: "PUBLISHED", isActive: true, publishedAt: new Date() },
        include: { steps: { orderBy: { order: "asc" } } }
      });
      if (draft.documentTypeId) {
        await tx.documentType.update({ where: { id: draft.documentTypeId }, data: { defaultWorkflowId: id } });
      }
      await writeAuditInTransaction(tx, {
        userId: req.user!.id,
        entityType: "WORKFLOW_DEFINITION",
        entityId: id,
        action: "PUBLISHED",
        after: { version: published.version },
        ...requestAuditContext(req)
      });
      return published;
    });
    res.json(definition);
  })
);

/** Wyłączenie schematu: typ dokumentu wraca do reguł warunkowych. Trwające obiegi idą dalej ze swojej kopii. */
rulesRouter.post(
  "/workflow-definitions/:id/deactivate",
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    const definition = await prisma.$transaction(async (tx) => {
      const before = await tx.workflowDefinition.findUnique({ where: { id } });
      if (!before) throw new AppError(404, "Nie znaleziono definicji obiegu");
      const updated = await tx.workflowDefinition.update({ where: { id }, data: { isActive: false } });
      await tx.documentType.updateMany({ where: { defaultWorkflowId: id }, data: { defaultWorkflowId: null } });
      await writeAuditInTransaction(tx, {
        userId: req.user!.id,
        entityType: "WORKFLOW_DEFINITION",
        entityId: id,
        action: "DEACTIVATED",
        ...requestAuditContext(req)
      });
      return updated;
    });
    res.json(definition);
  })
);
