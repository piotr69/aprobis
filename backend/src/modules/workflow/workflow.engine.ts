import { Prisma, type WorkflowTask } from "@prisma/client";
import { prisma } from "../../shared/prisma.js";
import { AppError } from "../../shared/http.js";
import { writeAuditInTransaction } from "../../shared/audit.js";
import { serializableTransaction } from "../../shared/transactions.js";
import { canPerformTask, isActiveMembership, isSelfApproval } from "../../shared/taskAccess.js";
import {
  TASK_MAIL_TOPIC,
  STAGE_INFO_MAIL_TOPIC,
  StageKind,
  StageRecipientStatus,
  AssigneeType,
  DocumentStatus,
  SystemRole,
  WorkflowActionType,
  WorkflowInstanceStatus,
  WorkflowStepType,
  WorkflowTaskStatus,
  SUBMITTABLE_DOCUMENT_STATUSES,
  type SystemRole as SystemRoleType
} from "../../shared/domain.js";
import { exceedsApprovalLimit } from "../../shared/approvalLimit.js";
import { canDecideTasks, ROLE_DEFINITIONS } from "../../shared/roles.js";
import { validateDocumentForPhase } from "../document-types/document-config.service.js";
import { matchesRuleConditions, parseActions, parseConditions, type RuleStepAction } from "./ruleMatcher.js";
import { DEFAULT_STAGE, pickDefinition } from "./workflowSource.js";
import { isFileUsable, usableScanStatuses } from "../files/fileAvailability.js";

export type RequestContext = {
  userId: string;
  role?: SystemRoleType;
  actingFor?: Array<{ id: string; role: SystemRoleType }>;
  correlationId: string;
  ipAddress?: string;
  userAgent?: string;
};

type DecisionInput = {
  decision: "APPROVE" | "REJECT" | "RETURN";
  comment?: string;
  expectedVersion: number;
};

type DelegateInput = { delegateToUserId: string; expectedVersion: number };
type ReassignInput = { assignToUserId: string; comment: string; expectedVersion: number };

type Candidate = { userId?: string; roleId?: string; groupId?: string; source: string };

type PlannedAssignment = {
  assignedToId: string | null;
  assignedRole: string | null;
  candidates: Candidate[];
};

type PlannedStage = {
  sourceStepId?: string;
  name: string;
  stageNo: number;
  parallelGroup: number;
  dueDays: number;
  completionMode: "ALL" | "ANY" | "QUORUM";
  requiredApprovals: number;
  rejectMode: string;
  requiresComment: boolean;
  requiresAttachment: boolean;
  canDelegate: boolean;
  canReturn: boolean;
  allowSelfApproval: boolean;
  exitConditionJson?: string;
  assignments: PlannedAssignment[];
  /** Autor był jedyną wskazaną osobą, więc etap przejął jego przełożony. */
  authorReplaced: boolean;
  stageKind: StageKind;
  /** Tylko INFO: adresaci zapisywani w kopii etapu; konkretne konta ustala się, gdy obieg dojdzie do etapu. */
  infoRecipients?: { users: string[]; manager: boolean };
};

type AssignmentSpec = RuleStepAction & { roleId?: string; groupId?: string };

const ACTIVE_TASK_STATUSES = [WorkflowTaskStatus.OPEN, WorkflowTaskStatus.PENDING, WorkflowTaskStatus.OVERDUE];
const DEFAULT_DUE_DAYS = 2;

function addDays(date: Date, days: number) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function normalizeCompletionMode(value: string | undefined): PlannedStage["completionMode"] {
  return value === "ANY" || value === "QUORUM" ? value : "ALL";
}

export function isStageComplete(mode: "ALL" | "ANY" | "QUORUM", requiredApprovals: number, statuses: string[]) {
  const completed = statuses.filter((status) => status === WorkflowTaskStatus.COMPLETED).length;
  if (mode === "ANY") return completed >= 1;
  if (mode === "QUORUM") return completed >= requiredApprovals;
  return statuses.length > 0 && completed === statuses.length;
}

async function loadDocumentContext(documentId: string) {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: {
      type: true,
      department: true,
      author: true,
      files: { select: { mimeType: true, size: true, scanStatus: true } }
    }
  });
  if (!document) throw new AppError(404, "Nie znaleziono dokumentu");
  return document;
}

type DocumentContext = Awaited<ReturnType<typeof loadDocumentContext>>;

const LIMIT_SELECT = { approvalLimitAmount: true, approvalLimitCurrency: true } as const;

/** Pierwsza osoba w górę łańcucha, która może decydować i ma dość wysoki limit. Odporny na cykle w danych. */
async function nextActiveManager(startId: string | null, document: DocumentContext) {
  const authorId = document.authorId;
  const visited = new Set<string>();
  let currentId = startId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const user: { id: string; isActive: boolean; managerId: string | null; role: string; approvalLimitAmount: unknown; approvalLimitCurrency: string } | null = await prisma.user.findUnique({
      where: { id: currentId },
      select: { id: true, isActive: true, managerId: true, role: true, ...LIMIT_SELECT }
    });
    if (!user) return null;
    if (user.isActive && user.id !== authorId && canDecideTasks(user.role) && !exceedsApprovalLimit(user, document)) return user.id;
    currentId = user.managerId;
  }
  return null;
}

/** Osoby z roli, które mogą zdecydować o tym dokumencie: bez autora i bez osób z za niskim limitem. */
async function activeRoleMembers(role: string, document: DocumentContext, departmentId?: string | null) {
  if (!canDecideTasks(role)) return [];
  const users = await prisma.user.findMany({
    where: { role, isActive: true, id: { not: document.authorId }, ...(departmentId ? { departmentId } : {}) },
    select: { id: true, ...LIMIT_SELECT }
  });
  return users.filter((user) => !exceedsApprovalLimit(user, document)).map((user) => user.id);
}

async function canUserDecide(userId: string | null, document: DocumentContext) {
  if (!userId || userId === document.authorId) return false;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { isActive: true, role: true, ...LIMIT_SELECT } });
  return Boolean(user?.isActive && canDecideTasks(user.role) && !exceedsApprovalLimit(user, document));
}

/**
 * Kto zajmie się etapem, gdy wyznaczona osoba lub rola nie może: przełożony autora,
 * a na końcu łańcucha zarząd. Lepiej przekazać decyzję wyżej, niż utworzyć zadanie,
 * którego nikt nie może wykonać. Gdy nie ma nikogo, odmawiamy złożenia dokumentu.
 */
async function escalate(stepName: string, document: DocumentContext): Promise<PlannedAssignment> {
  const managerId = await nextActiveManager(document.author.managerId, document);
  if (managerId) return { assignedToId: managerId, assignedRole: null, candidates: [{ userId: managerId, source: "ESCALATION" }] };
  if ((await activeRoleMembers(SystemRole.BOARD, document)).length) {
    return { assignedToId: null, assignedRole: SystemRole.BOARD, candidates: [] };
  }
  throw new AppError(422, `Nie można wyznaczyć osoby akceptującej etap „${stepName}”: nikt nie może podjąć tej decyzji albo kwota przekracza limity wszystkich osób. Skontaktuj się z administratorem`);
}

async function selectedUserCannotDecide(stepName: string, userId: string, document: DocumentContext) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true, isActive: true, role: true, ...LIMIT_SELECT } });
  const name = user ? `${user.firstName} ${user.lastName}` : "wskazana osoba";
  const reason = !user || !user.isActive
    ? "konto jest nieaktywne"
    : !canDecideTasks(user.role)
      ? "jej rola nie pozwala podejmować decyzji"
      : exceedsApprovalLimit(user, document)
        ? "kwota przekracza jej limit akceptacji"
        : "nie może zdecydować o tym dokumencie";
  return new AppError(422, `Etap „${stepName}”: ${name} — ${reason}. Schemat akceptacji trzeba poprawić. Skontaktuj się z administratorem`);
}

/**
 * Przypisania jednego etapu. Autor nie decyduje o własnym dokumencie, więc znika z listy wybranych osób;
 * gdy był na niej jedyny, etap przejmuje jego przełożony (zwykła eskalacja). Ta sama osoba nie dostaje
 * w jednym etapie dwóch zadań, np. gdy przełożony autora jest też na liście.
 */
async function resolveStageAssignments(stageName: string, specs: AssignmentSpec[], document: DocumentContext) {
  const isAuthor = (spec: AssignmentSpec) => spec.assigneeType === AssigneeType.USER && !spec.groupId && spec.assigneeUserId === document.authorId && !spec.allowSelfApproval;
  const others = specs.filter((spec) => !isAuthor(spec));
  const authorReplaced = others.length === 0;
  const resolved = authorReplaced
    ? [await escalate(stageName, document)]
    : await Promise.all(others.map((spec) => resolveAssignment(spec, document)));
  const seen = new Set<string>();
  const assignments = resolved.filter((assignment) => {
    if (!assignment.assignedToId) return true;
    if (seen.has(assignment.assignedToId)) return false;
    seen.add(assignment.assignedToId);
    return true;
  });
  return { assignments, authorReplaced };
}

async function resolveAssignment(step: AssignmentSpec, document: DocumentContext): Promise<PlannedAssignment> {
  const person = (id: string, source: string): PlannedAssignment => ({
    assignedToId: id,
    assignedRole: null,
    candidates: [{ userId: id, source }]
  });

  if (step.groupId) {
    const group = await prisma.group.findUnique({ where: { id: step.groupId }, include: { members: { include: { user: { select: { isActive: true, role: true, ...LIMIT_SELECT } } } } } });
    const now = new Date();
    const eligible = group?.members.some((member) => member.userId !== document.authorId && member.user.isActive && canDecideTasks(member.user.role) && !exceedsApprovalLimit(member.user, document) && isActiveMembership(member, now));
    return eligible
      ? { assignedToId: null, assignedRole: null, candidates: [{ groupId: step.groupId, source: "GROUP" }] }
      : escalate(step.name, document);
  }

  switch (step.assigneeType) {
    case AssigneeType.AUTHOR:
      return step.allowSelfApproval ? person(document.authorId, "AUTHOR") : escalate(step.name, document);
    case AssigneeType.MANAGER:
      return escalate(step.name, document);
    case AssigneeType.DEPARTMENT_MANAGER: {
      const managerId = document.department?.managerId ?? null;
      return managerId && (await canUserDecide(managerId, document))
        ? person(managerId, "DEPARTMENT_MANAGER")
        : escalate(step.name, document);
    }
    case AssigneeType.USER: {
      // Wskazanej osoby nie zastępujemy po cichu kimś innym: ekran schematu obiecuje właśnie ją.
      // Autora wyklucza wcześniej resolveStageAssignments, więc tu trafia tylko ktoś inny.
      const userId = step.assigneeUserId ?? null;
      if (!userId) throw new AppError(422, `Etap „${step.name}” nie ma wskazanej osoby. Skontaktuj się z administratorem`);
      if (await canUserDecide(userId, document)) return person(userId, "USER");
      throw await selectedUserCannotDecide(step.name, userId, document);
    }
    case AssigneeType.BOARD:
    case AssigneeType.ROLE: {
      const role = step.assigneeType === AssigneeType.BOARD ? SystemRole.BOARD : step.assigneeRole;
      if (!role) throw new AppError(422, `Etap „${step.name}” nie ma wskazanej roli. Skontaktuj się z administratorem`);
      return (await activeRoleMembers(role, document)).length
        ? { assignedToId: null, assignedRole: role, candidates: [] }
        : escalate(step.name, document);
    }
    case AssigneeType.DEPARTMENT_ROLE: {
      if (!step.assigneeRole) throw new AppError(422, `Etap „${step.name}” nie ma wskazanej roli. Skontaktuj się z administratorem`);
      const members = await activeRoleMembers(step.assigneeRole, document, step.assigneeDepartmentId ?? document.departmentId);
      return members.length
        ? { assignedToId: null, assignedRole: null, candidates: members.map((userId) => ({ userId, source: "DEPARTMENT_ROLE" })) }
        : escalate(step.name, document);
    }
    default:
      throw new AppError(422, `Etap „${step.name}” ma nieznany sposób przypisania. Skontaktuj się z administratorem`);
  }
}

async function findWorkflow(defaultWorkflowId: string | null, documentTypeId: string) {
  const candidates = await prisma.workflowDefinition.findMany({
    where: { documentTypeId, isActive: true, status: "PUBLISHED" },
    include: {
      steps: {
        include: { assignees: { include: { role: true } } },
        orderBy: [{ stageNo: "asc" as const }, { parallelGroup: "asc" as const }, { order: "asc" as const }]
      }
    }
  });
  return pickDefinition(defaultWorkflowId, candidates);
}

function stepAction(step: NonNullable<Awaited<ReturnType<typeof findWorkflow>>>["steps"][number]): RuleStepAction {
  return {
    stepId: step.id,
    name: step.name,
    stepType: step.stepType,
    stageKind: step.stageKind,
    assigneeType: step.assigneeType,
    assigneeRole: step.assigneeRole ?? undefined,
    assigneeUserId: step.assigneeUserId ?? undefined,
    assigneeDepartmentId: step.assigneeDepartmentId ?? undefined,
    dueDays: step.dueDays,
    requiresComment: step.requiresComment,
    requiresAttachment: step.requiresAttachment,
    canDelegate: step.canDelegate,
    canReturn: step.canReturn,
    allowSelfApproval: step.allowSelfApproval,
    stageNo: step.stageNo,
    parallelGroup: step.parallelGroup,
    completionMode: normalizeCompletionMode(step.completionMode),
    requiredApprovals: step.requiredApprovals,
    rejectMode: step.rejectMode,
    entryConditionJson: step.entryConditionJson ?? undefined,
    exitConditionJson: step.exitConditionJson ?? undefined
  };
}

function brokenConfiguration(name: string) {
  return new AppError(422, `Konfiguracja „${name}” jest uszkodzona, więc nie można ustalić ścieżki akceptacji. Skontaktuj się z administratorem`);
}

async function matchingRuleSteps(document: DocumentContext) {
  const now = new Date();
  const rules = await prisma.approvalRule.findMany({
    where: { isActive: true, OR: [{ documentTypeId: document.typeId }, { documentTypeId: null }] },
    orderBy: [{ priority: "asc" }, { name: "asc" }]
  });
  const steps: RuleStepAction[] = [];
  for (const rule of rules) {
    if ((rule.validFrom && rule.validFrom > now) || (rule.validTo && rule.validTo < now)) continue;
    // Uszkodzonej reguły nie wolno pominąć: mogłaby właśnie wymagać dodatkowej akceptacji.
    const conditions = parseConditions(rule.conditionsJson);
    if (!conditions) throw brokenConfiguration(rule.name);
    if (!matchesRuleConditions(conditions, document)) continue;
    const actions = parseActions(rule.actionsJson);
    if (!actions) throw brokenConfiguration(rule.name);
    steps.push(...(actions.steps ?? []));
    if (actions.stopProcessing) break;
  }
  // Etapy z wielu reguł układają się kolejno, inaczej numery etapów ze sobą kolidują.
  return steps.map((step, index) => ({ ...step, stageNo: index + 1, parallelGroup: 1 }));
}

async function resolveStages(document: DocumentContext) {
  const definition = await findWorkflow(document.type.defaultWorkflowId, document.typeId);
  let steps: Array<RuleStepAction & { assignments?: AssignmentSpec[] }>;

  if (definition?.steps.length) {
    steps = definition.steps.map((step) => ({
      ...stepAction(step),
      assignments: step.assignees.length
        ? step.assignees.map((assignee) => ({
            ...stepAction(step),
            assigneeType: assignee.assigneeType,
            assigneeUserId: assignee.userId ?? undefined,
            assigneeDepartmentId: assignee.departmentId ?? undefined,
            assigneeRole: assignee.role?.code ?? undefined,
            groupId: assignee.groupId ?? undefined
          }))
        : undefined
    }));
  } else {
    steps = await matchingRuleSteps(document);
  }

  if (!steps.length) steps = [{ ...DEFAULT_STAGE }];

  const planned: PlannedStage[] = [];
  for (const [index, step] of steps.entries()) {
    if (step.entryConditionJson) {
      const entry = parseConditions(step.entryConditionJson);
      if (!entry) throw brokenConfiguration(step.name);
      if (!matchesRuleConditions(entry, document)) continue;
    }
    if (step.stageKind === StageKind.INFO) {
      // „Do wiadomości”: bez zadań; adresaci trafiają do kopii etapu, konta ustala się przy dojściu obiegu.
      const specs: AssignmentSpec[] = step.assignments?.length ? step.assignments : [step];
      const supported = specs.every((spec) => !spec.groupId && !spec.roleId && (spec.assigneeType === AssigneeType.MANAGER || (spec.assigneeType === AssigneeType.USER && spec.assigneeUserId)));
      if (!supported) throw brokenConfiguration(step.name);
      planned.push({
        sourceStepId: step.stepId,
        name: step.name,
        stageNo: step.stageNo ?? index + 1,
        parallelGroup: step.parallelGroup ?? 1,
        dueDays: DEFAULT_DUE_DAYS,
        completionMode: "ALL",
        requiredApprovals: 1,
        rejectMode: "STOP",
        requiresComment: false,
        requiresAttachment: false,
        canDelegate: false,
        canReturn: false,
        allowSelfApproval: false,
        assignments: [],
        authorReplaced: false,
        stageKind: StageKind.INFO,
        infoRecipients: {
          users: [...new Set(specs.flatMap((spec) => (spec.assigneeType === AssigneeType.USER && spec.assigneeUserId ? [spec.assigneeUserId] : [])))],
          manager: specs.some((spec) => spec.assigneeType === AssigneeType.MANAGER)
        }
      });
      continue;
    }
    const assignmentSpecs: AssignmentSpec[] = step.assignments?.length ? step.assignments : [step];
    const { assignments, authorReplaced } = await resolveStageAssignments(step.name, assignmentSpecs, document);
    const completionMode = normalizeCompletionMode(step.completionMode);
    const requiredApprovals = Math.max(1, step.requiredApprovals ?? 1);
    if (completionMode === "QUORUM" && requiredApprovals > assignments.length) throw brokenConfiguration(step.name);
    planned.push({
      sourceStepId: step.stepId,
      name: step.name,
      stageNo: step.stageNo ?? index + 1,
      parallelGroup: step.parallelGroup ?? 1,
      dueDays: step.dueDays ?? DEFAULT_DUE_DAYS,
      completionMode,
      requiredApprovals,
      rejectMode: "STOP",
      requiresComment: step.requiresComment ?? false,
      requiresAttachment: step.requiresAttachment ?? false,
      canDelegate: step.canDelegate ?? true,
      canReturn: step.canReturn ?? true,
      allowSelfApproval: step.allowSelfApproval ?? false,
      exitConditionJson: step.exitConditionJson,
      assignments,
      authorReplaced,
      stageKind: StageKind.DECISION
    });
  }
  // Także po warunkach wejścia i z reguł: bez decyzji człowieka dokument nie może zostać zatwierdzony.
  if (!planned.some((stage) => stage.stageKind === StageKind.DECISION)) {
    throw new AppError(422, "Dla tego dokumentu nie ma żadnego etapu akceptacji. Skontaktuj się z administratorem");
  }
  return { workflowDefinitionId: definition?.id ?? null, stages: planned };
}

/** Ścieżka, jaką przejdzie dokument, jeśli zostanie złożony teraz: autor widzi ją przed wysłaniem. */
export async function previewWorkflow(documentId: string) {
  const document = await loadDocumentContext(documentId);
  const { stages } = await resolveStages(document);
  // Odbiorców „do wiadomości” pokazujemy według stanu kont dziś; ostatecznie ustala ich dojście obiegu do etapu.
  const infoIds = new Map<PlannedStage, string[]>();
  for (const stage of stages) {
    if (stage.infoRecipients) infoIds.set(stage, await infoRecipientIds(prisma, stage.infoRecipients, document.authorId));
  }
  const userIds = [
    ...stages.flatMap((stage) => stage.assignments.flatMap((assignment) => [
      ...(assignment.assignedToId ? [assignment.assignedToId] : []),
      ...assignment.candidates.flatMap((candidate) => (candidate.userId ? [candidate.userId] : []))
    ])),
    ...[...infoIds.values()].flat()
  ];
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(userIds)] } }, select: { id: true, firstName: true, lastName: true } });
  const names = new Map(users.map((user) => [user.id, `${user.firstName} ${user.lastName}`]));
  return stages.map((stage) => ({
    stageNo: stage.stageNo,
    name: stage.name,
    dueDays: stage.dueDays,
    completionMode: stage.completionMode,
    authorReplaced: stage.authorReplaced,
    stageKind: stage.stageKind,
    approvers: stage.stageKind === StageKind.INFO
      ? (infoIds.get(stage) ?? []).map((id) => names.get(id) ?? "Nieznany użytkownik")
      : [...new Set(stage.assignments.flatMap((assignment): string[] => {
      if (assignment.assignedToId) return [names.get(assignment.assignedToId) ?? "Nieznany użytkownik"];
      if (assignment.assignedRole) return [ROLE_DEFINITIONS[assignment.assignedRole as SystemRoleType]?.label ?? assignment.assignedRole];
      const people = assignment.candidates.flatMap((candidate) => (candidate.userId ? [names.get(candidate.userId) ?? "Nieznany użytkownik"] : []));
      return people.length ? people : ["Wyznaczona grupa"];
    }))]
  }));
}

/** Wszyscy, którzy mogą wykonać zadanie, wraz z ich zastępcami; autor nigdy nie decyduje o swoim dokumencie. */
export async function taskRecipients(tx: Prisma.TransactionClient, taskId: string, authorId: string) {
  const task = await tx.workflowTask.findUniqueOrThrow({
    where: { id: taskId },
    include: { candidates: { include: { role: true, group: { include: { members: true } } } } }
  });
  const now = new Date();
  const ids = new Set<string>();
  if (task.assignedToId) ids.add(task.assignedToId);
  const roles = new Set<string>();
  if (!task.assignedToId && task.assignedRole) roles.add(task.assignedRole);
  for (const candidate of task.candidates) {
    if (candidate.userId) ids.add(candidate.userId);
    if (candidate.role) roles.add(candidate.role.code);
    for (const member of candidate.group?.members ?? []) {
      if (isActiveMembership(member, now)) ids.add(member.userId);
    }
  }
  if (roles.size) {
    const members = await tx.user.findMany({ where: { role: { in: [...roles] }, isActive: true }, select: { id: true } });
    members.forEach((member) => ids.add(member.id));
  }
  const withDecisionRight = async (candidateIds: Iterable<string>) => {
    const users = await tx.user.findMany({ where: { id: { in: [...candidateIds] }, isActive: true }, select: { id: true, role: true } });
    return users.filter((user) => user.id !== authorId && canDecideTasks(user.role)).map((user) => user.id);
  };
  // Zastępców szukamy tylko dla osób, które same mogą decydować: autor i role tylko do odczytu odpadają.
  const principals = await withDecisionRight(ids);
  const substitutes = await tx.userSubstitution.findMany({
    where: { userId: { in: principals }, isActive: true, scope: "ALL", validFrom: { lte: now }, validTo: { gte: now } },
    select: { substituteUserId: true }
  });
  return [...new Set([...principals, ...(await withDecisionRight(substitutes.map((item) => item.substituteUserId)))])];
}

function clip(text: string, length: number) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

async function notifyTaskOpened(
  tx: Prisma.TransactionClient,
  task: { id: string; documentId: string; name: string; version: number },
  document: { authorId: string; title: string; number: string }
) {
  const recipients = await taskRecipients(tx, task.id, document.authorId);
  if (!recipients.length) return;
  await tx.notification.createMany({
    data: recipients.map((userId) => ({
      userId,
      documentId: task.documentId,
      taskId: task.id,
      type: "TASK_ASSIGNED",
      title: clip(`Czeka na Twoją decyzję: ${document.title}`, 180),
      body: clip(`${document.number} · ${task.name}`, 500)
    }))
  });
  // W tej samej transakcji: wycofana decyzja nie zostawia maila, a wysyłkę wykonuje worker.
  await tx.outboxMessage.createMany({
    data: recipients.map((userId) => ({
      topic: TASK_MAIL_TOPIC,
      aggregateType: "WorkflowTask",
      aggregateId: task.id,
      payloadJson: JSON.stringify({ userId, documentId: task.documentId, taskId: task.id, taskVersion: task.version })
    }))
  });
}

async function notifyAuthor(
  tx: Prisma.TransactionClient,
  document: { id: string; authorId: string; title: string; number: string },
  type: string,
  title: string,
  body?: string
) {
  await tx.notification.create({
    data: {
      userId: document.authorId,
      documentId: document.id,
      type,
      title: clip(`${title}: ${document.title}`, 180),
      body: clip(body?.trim() ? body.trim() : document.number, 500)
    }
  });
}

export async function startWorkflow(documentId: string, context: RequestContext) {
  const document = await loadDocumentContext(documentId);
  const resolved = await resolveStages(document);
  await validateDocumentForPhase({
    typeId: document.typeId,
    typeVersionId: document.typeVersionId,
    data: JSON.parse(document.dataJson || document.metadataJson || "{}"),
    amount: document.amount?.toString(),
    contractorName: document.contractorName,
    cleanFiles: document.files.filter((file) => isFileUsable(file.scanStatus))
  }, "SUBMIT");
  if (document.files.some((file) => file.scanStatus === "REJECTED")) {
    throw new AppError(400, "Antywirus zablokował jeden z załączników. Usuń go przed złożeniem dokumentu");
  }

  return serializableTransaction(async (tx) => {
    const current = await tx.document.findUnique({ where: { id: documentId } });
    if (!current) throw new AppError(404, "Nie znaleziono dokumentu");
    if (!SUBMITTABLE_DOCUMENT_STATUSES.includes(current.status)) {
      throw new AppError(409, "Tego dokumentu nie można teraz złożyć");
    }
    // Plan powstał na odczycie sprzed transakcji: gdyby dokument zmienił się w międzyczasie,
    // zatwierdzalibyśmy nową kwotę według ścieżki wyliczonej dla starej.
    if (current.version !== document.version) {
      throw new AppError(409, "Dokument został właśnie zmieniony. Odśwież stronę i spróbuj ponownie");
    }

    await tx.workflowInstance.updateMany({
      where: { documentId, status: WorkflowInstanceStatus.NEEDS_CORRECTION },
      data: { status: WorkflowInstanceStatus.CANCELLED, completedAt: new Date() }
    });

    const instance = await tx.workflowInstance.create({
      data: {
        documentId,
        workflowDefinitionId: resolved.workflowDefinitionId ?? undefined,
        startedById: context.userId,
        status: WorkflowInstanceStatus.ACTIVE
      }
    });
    const now = new Date();

    // Wszystkie etapy powstają jako oczekujące; otwiera je jedna wspólna operacja przejścia (advanceStages),
    // ta sama co po decyzji. Dzięki temu „do wiadomości” na początku ścieżki działa jak w środku i na końcu.
    for (const stage of resolved.stages) {
      const snapshot = await tx.workflowInstanceStage.create({
        data: {
          instanceId: instance.id,
          sourceStepId: stage.sourceStepId,
          stageNo: stage.stageNo,
          parallelGroup: stage.parallelGroup,
          name: stage.name,
          stageKind: stage.stageKind,
          completionMode: stage.completionMode,
          requiredApprovals: stage.requiredApprovals,
          rejectMode: stage.rejectMode,
          requiresComment: stage.requiresComment,
          requiresAttachment: stage.requiresAttachment,
          canDelegate: stage.canDelegate,
          canReturn: stage.canReturn,
          configSnapshotJson: JSON.stringify({
            allowSelfApproval: stage.allowSelfApproval,
            exitConditionJson: stage.exitConditionJson,
            dueDays: stage.dueDays,
            // Autor był jedyną wskazaną osobą: historia obiegu musi pokazać, dlaczego decyduje przełożony.
            ...(stage.authorReplaced ? { authorReplaced: true } : {}),
            // Adresaci „do wiadomości” z chwili złożenia: późniejsza zmiana schematu nie zmienia trwającego obiegu.
            ...(stage.infoRecipients ? { recipients: stage.infoRecipients } : {})
          }),
          status: "PENDING"
        }
      });

      for (const [assignmentIndex, assignment] of stage.assignments.entries()) {
        await tx.workflowTask.create({
          data: {
            instanceId: instance.id,
            instanceStageId: snapshot.id,
            stepId: stage.sourceStepId,
            documentId,
            assignedToId: assignment.assignedToId,
            assignedRole: assignment.assignedRole,
            status: WorkflowTaskStatus.PENDING,
            name: stage.name,
            order: stage.stageNo * 1000 + stage.parallelGroup * 100 + assignmentIndex,
            // Termin biegnie od otwarcia etapu.
            candidates: assignment.candidates.length ? { create: assignment.candidates } : undefined
          }
        });
      }
    }

    const changed = await tx.document.updateMany({
      where: { id: documentId, version: current.version, status: current.status },
      data: { status: DocumentStatus.IN_APPROVAL, submittedAt: now, version: { increment: 1 } }
    });
    if (changed.count !== 1) throw new AppError(409, "Dokument został właśnie zmieniony. Odśwież stronę i spróbuj ponownie");
    const { tasks } = await advanceStages(tx, instance.id, current, context);
    const updated = await tx.document.findUniqueOrThrow({ where: { id: documentId } });

    await tx.workflowAction.create({
      data: { documentId, userId: context.userId, actionType: WorkflowActionType.SUBMIT }
    });
    await writeAuditInTransaction(tx, {
      userId: context.userId,
      entityType: "DOCUMENT",
      entityId: documentId,
      action: "WORKFLOW_STARTED",
      after: {
        instanceId: instance.id,
        taskIds: tasks.map((task) => task.id),
        ...(resolved.stages.some((stage) => stage.authorReplaced)
          ? { authorReplacedStages: resolved.stages.filter((stage) => stage.authorReplaced).map((stage) => stage.name) }
          : {})
      },
      correlationId: context.correlationId,
      recordVersion: updated.version,
      statusBefore: current.status,
      statusAfter: updated.status,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent
    });
    return { instance, tasks, document: updated };
  });
}

function loadTaskForDecision(taskId: string) {
  return prisma.workflowTask.findUnique({
    where: { id: taskId },
    include: {
      document: { include: { _count: { select: { files: { where: { scanStatus: { in: usableScanStatuses() } } } } } } },
      instance: true,
      instanceStage: true,
      step: true,
      candidates: { include: { role: true, group: { include: { members: true } } } }
    }
  });
}

type LoadedTask = NonNullable<Awaited<ReturnType<typeof loadTaskForDecision>>>;

function identityCanPerform(task: LoadedTask, identity: { userId: string; role?: SystemRoleType }, now: Date) {
  if (canPerformTask(task, identity)) return true;
  // Zadanie przypisane konkretnej osobie należy tylko do niej.
  if (task.assignedToId) return false;
  return task.candidates.some((candidate) =>
    candidate.userId === identity.userId ||
    (Boolean(identity.role) && candidate.role?.code === identity.role) ||
    candidate.group?.members.some((member) => member.userId === identity.userId && isActiveMembership(member, now))
  );
}

/**
 * Ustala, w czyim imieniu użytkownik działa. Zastępstwo sprawdzamy w chwili decyzji,
 * więc obejmuje też zadania otwarte przed jego rozpoczęciem i wygasa razem z nim.
 */
function resolveActor(task: LoadedTask, context: RequestContext) {
  if (!context.role || !canDecideTasks(context.role)) return { allowed: false as const };
  const now = new Date();
  if (identityCanPerform(task, { userId: context.userId, role: context.role }, now)) return { allowed: true as const };
  // Zastępca przejmuje tylko to, co zastępowany sam może zrobić: nigdy decyzji o jego dokumencie.
  const principal = context.actingFor?.find((item) =>
    item.id !== task.document.authorId && identityCanPerform(task, { userId: item.id, role: item.role }, now)
  );
  return principal ? { allowed: true as const, substitutedForUserId: principal.id } : { allowed: false as const };
}

async function cancelRemainingWork(tx: Prisma.TransactionClient, instanceId: string, exceptStageId?: string | null) {
  const now = new Date();
  await tx.workflowTask.updateMany({
    where: { instanceId, status: { in: ACTIVE_TASK_STATUSES } },
    data: { status: WorkflowTaskStatus.CANCELLED, completedAt: now, version: { increment: 1 } }
  });
  await tx.workflowInstanceStage.updateMany({
    where: { instanceId, status: { in: ["OPEN", "PENDING"] }, ...(exceptStageId ? { id: { not: exceptStageId } } : {}) },
    data: { status: "CANCELLED", completedAt: now }
  });
}

/** Anulowanie wszystkich otwartych prac dokumentu: wycofanie przez autora lub administratora. */
export async function cancelWorkflowOfDocument(tx: Prisma.TransactionClient, documentId: string) {
  const now = new Date();
  await revokeInfoGrants(tx, { documentId });
  await tx.workflowTask.updateMany({
    where: { documentId, status: { in: ACTIVE_TASK_STATUSES } },
    data: { status: WorkflowTaskStatus.CANCELLED, completedAt: now, version: { increment: 1 } }
  });
  await tx.workflowInstanceStage.updateMany({
    where: { instance: { documentId }, status: { in: ["OPEN", "PENDING"] } },
    data: { status: "CANCELLED", completedAt: now }
  });
  await tx.workflowInstance.updateMany({
    where: { documentId, status: { in: [WorkflowInstanceStatus.ACTIVE, WorkflowInstanceStatus.NEEDS_CORRECTION] } },
    data: { status: WorkflowInstanceStatus.CANCELLED, completedAt: now }
  });
}

type StageDocument = { id: string; authorId: string; title: string; number: string };
type InfoRecipientsSpec = { users: string[]; manager: boolean };
type StageContext = Pick<RequestContext, "userId" | "correlationId" | "ipAddress" | "userAgent">;

/** Pierwszy aktywny przełożony autora w górę łańcucha. Bez limitu i roli decyzyjnej: to nie decyzja. Odporny na cykle. */
async function firstActiveManager(db: Prisma.TransactionClient, authorId: string) {
  const author = await db.user.findUnique({ where: { id: authorId }, select: { managerId: true } });
  const visited = new Set<string>([authorId]);
  let currentId = author?.managerId ?? null;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const user: { id: string; isActive: boolean; managerId: string | null } | null = await db.user.findUnique({
      where: { id: currentId },
      select: { id: true, isActive: true, managerId: true }
    });
    if (!user) return null;
    if (user.isActive) return user.id;
    currentId = user.managerId;
  }
  return null;
}

/** Odbiorcy etapu „do wiadomości” teraz: aktywne konta z kopii adresatów, bez autora, bez powtórzeń. */
export async function infoRecipientIds(db: Prisma.TransactionClient, spec: InfoRecipientsSpec, authorId: string) {
  const users = spec.users.length
    ? await db.user.findMany({ where: { id: { in: spec.users }, isActive: true, NOT: { id: authorId } }, select: { id: true } })
    : [];
  const ids = users.map((user) => user.id);
  if (spec.manager) {
    const managerId = await firstActiveManager(db, authorId);
    if (managerId) ids.push(managerId);
  }
  return [...new Set(ids)];
}

function snapshotRecipients(snapshotJson: string | null): InfoRecipientsSpec {
  const value = (snapshotJson ? JSON.parse(snapshotJson) : {}) as { recipients?: { users?: unknown; manager?: unknown } };
  const users = Array.isArray(value.recipients?.users) ? value.recipients.users.filter((id): id is string => typeof id === "string") : [];
  return { users, manager: value.recipients?.manager === true };
}

/**
 * Realizacja etapu „do wiadomości”: wgląd, powiadomienie, mail (outbox) i audyt w transakcji decyzji albo złożenia.
 * Najpierw przejście PENDING → COMPLETED/SKIPPED (CAS); kto przegra, nie tworzy żadnych skutków.
 * Ponowienie transakcji czyta stan od nowa, więc zakończony etap niczego nie dopisze.
 */
async function realizeInfoStage(
  tx: Prisma.TransactionClient,
  stage: { id: string; name: string; configSnapshotJson: string | null },
  document: StageDocument,
  context: StageContext
) {
  const recipients = await infoRecipientIds(tx, snapshotRecipients(stage.configSnapshotJson), document.authorId);
  const now = new Date();
  const moved = await tx.workflowInstanceStage.updateMany({
    where: { id: stage.id, status: "PENDING" },
    data: { status: recipients.length ? "COMPLETED" : "SKIPPED", openedAt: now, completedAt: now }
  });
  if (moved.count !== 1) return;
  const audit = {
    userId: context.userId,
    correlationId: context.correlationId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    entityType: "DOCUMENT",
    entityId: document.id
  };
  if (!recipients.length) {
    // Brak adresata nie może blokować dokumentu, ale historia mówi wprost, że nikt informacji nie dostał.
    await writeAuditInTransaction(tx, { ...audit, action: "STAGE_INFO_SKIPPED", after: { stageId: stage.id, stageName: stage.name, reason: "Brak aktywnego odbiorcy" } });
    return;
  }
  for (const userId of recipients) {
    const recipient = await tx.workflowStageRecipient.create({ data: { instanceStageId: stage.id, documentId: document.id, userId } });
    await tx.notification.create({
      data: {
        userId,
        documentId: document.id,
        type: "STAGE_INFO",
        title: clip(`Do wiadomości: ${document.title}`, 180),
        body: clip(`${document.number} · ${stage.name}`, 500)
      }
    });
    await tx.outboxMessage.create({
      data: {
        topic: STAGE_INFO_MAIL_TOPIC,
        aggregateType: "WorkflowStageRecipient",
        aggregateId: recipient.id,
        payloadJson: JSON.stringify({ recipientId: recipient.id })
      }
    });
  }
  // Zapis do outboxa to kolejka, a nie doręczenie: stąd QUEUED.
  await writeAuditInTransaction(tx, { ...audit, action: "STAGE_INFO_QUEUED", after: { stageId: stage.id, stageName: stage.name, userIds: recipients } });
}

/**
 * Jedna operacja przejścia obiegu, przy złożeniu i po każdym zakończonym etapie. Dopóki jakiś etap jest otwarty
 * (np. równoległa decyzja), nic nie rusza dalej. Etapy „do wiadomości” realizuje od razu i idzie dalej;
 * na etapie decyzji otwiera zadania i kończy. O zatwierdzeniu dokumentu decyduje wywołujący: brak OPEN i PENDING.
 */
async function advanceStages(tx: Prisma.TransactionClient, instanceId: string, document: StageDocument, context: StageContext) {
  const opened: WorkflowTask[] = [];
  const instance = await tx.workflowInstance.findUnique({ where: { id: instanceId }, select: { status: true } });
  if (instance?.status !== WorkflowInstanceStatus.ACTIVE) return { tasks: opened };
  for (;;) {
    if (await tx.workflowInstanceStage.count({ where: { instanceId, status: "OPEN" } })) break;
    const nextStage = await tx.workflowInstanceStage.findFirst({
      where: { instanceId, status: "PENDING" },
      orderBy: [{ stageNo: "asc" }, { parallelGroup: "asc" }]
    });
    if (!nextStage) break;
    const stages = await tx.workflowInstanceStage.findMany({ where: { instanceId, stageNo: nextStage.stageNo, status: "PENDING" } });
    for (const stage of stages.filter((item) => item.stageKind === StageKind.INFO)) await realizeInfoStage(tx, stage, document, context);
    const decisions = stages.filter((item) => item.stageKind !== StageKind.INFO);
    if (!decisions.length) continue;

    const now = new Date();
    await tx.workflowInstanceStage.updateMany({
      where: { id: { in: decisions.map((stage) => stage.id) } },
      data: { status: "OPEN", openedAt: now }
    });
    for (const stage of decisions) {
      await tx.workflowTask.updateMany({
        where: { instanceStageId: stage.id, status: WorkflowTaskStatus.PENDING },
        data: { status: WorkflowTaskStatus.OPEN, dueAt: addDays(now, stageDueDays(stage.configSnapshotJson)), version: { increment: 1 } }
      });
    }
    const tasks = await tx.workflowTask.findMany({
      where: { instanceStageId: { in: decisions.map((stage) => stage.id) }, status: WorkflowTaskStatus.OPEN }
    });
    for (const task of tasks) await notifyTaskOpened(tx, task, document);
    await tx.document.update({
      where: { id: document.id },
      data: { currentStepName: decisions.map((stage) => stage.name).join(" / "), version: { increment: 1 } }
    });
    opened.push(...tasks);
    break;
  }
  return { tasks: opened };
}

/** Cofnięcie wglądu „do wiadomości”: zwrot do poprawy i anulowanie. Inne podstawy dostępu zostają. */
async function revokeInfoGrants(tx: Prisma.TransactionClient, where: Prisma.WorkflowStageRecipientWhereInput) {
  await tx.workflowStageRecipient.updateMany({
    where: { ...where, status: StageRecipientStatus.GRANTED },
    data: { status: StageRecipientStatus.REVOKED, revokedAt: new Date() }
  });
}

function stageDueDays(snapshotJson: string | null) {
  try {
    const value = (snapshotJson ? JSON.parse(snapshotJson) : {}) as { dueDays?: unknown };
    return typeof value.dueDays === "number" && value.dueDays > 0 ? value.dueDays : DEFAULT_DUE_DAYS;
  } catch {
    return DEFAULT_DUE_DAYS;
  }
}

async function actorComment(substitutedForUserId: string | undefined, comment: string | undefined) {
  if (!substitutedForUserId) return comment;
  const principal = await prisma.user.findUnique({ where: { id: substitutedForUserId }, select: { firstName: true, lastName: true } });
  const prefix = `W zastępstwie: ${principal?.firstName ?? ""} ${principal?.lastName ?? ""}`.trim();
  return comment?.trim() ? `${prefix}. ${comment.trim()}` : prefix;
}

export async function performDecision(taskId: string, input: DecisionInput, context: RequestContext) {
  const task = await loadTaskForDecision(taskId);
  if (!task) throw new AppError(404, "Nie znaleziono zadania");
  if (task.status !== WorkflowTaskStatus.OPEN) throw new AppError(409, "To zadanie jest już zamknięte");
  // Decyzja ma sens tylko w trwającym obiegu. To także zamyka starą ścieżkę, w której autor
  // „zatwierdzał” zadanie korekty i dostawał dokument APPROVED bez akceptacji przełożonego.
  if (task.document.status !== DocumentStatus.IN_APPROVAL || task.instance.status !== WorkflowInstanceStatus.ACTIVE) {
    throw new AppError(409, "Dokument nie czeka już na decyzję");
  }
  const actor = resolveActor(task, context);
  if (!actor.allowed) throw new AppError(403, "To zadanie nie jest przypisane do Ciebie");
  if (isSelfApproval(task, context.userId)) throw new AppError(403, "Nie możesz podejmować decyzji o własnym dokumencie");

  const stage = task.instanceStage;
  const requiresComment = stage?.requiresComment ?? task.step?.requiresComment ?? false;
  const requiresAttachment = stage?.requiresAttachment ?? task.step?.requiresAttachment ?? false;
  const canReturn = stage?.canReturn ?? task.step?.canReturn ?? true;
  if ((input.decision !== "APPROVE" || requiresComment) && !input.comment?.trim()) {
    throw new AppError(400, input.decision === "APPROVE" ? "Na tym etapie komentarz jest wymagany" : "Podaj uzasadnienie decyzji");
  }
  if (input.decision === "APPROVE" && requiresAttachment && task.document._count.files < 1) {
    throw new AppError(400, "Na tym etapie dokument musi mieć przeskanowany załącznik");
  }
  if (input.decision === "RETURN" && !canReturn) throw new AppError(403, "Na tym etapie nie można zwrócić dokumentu do poprawy");

  const actionType = input.decision === "APPROVE"
    ? WorkflowActionType.APPROVE
    : input.decision === "REJECT" ? WorkflowActionType.REJECT : WorkflowActionType.RETURN;
  const comment = await actorComment(actor.substitutedForUserId, input.comment);
  const auditBase = {
    userId: context.userId,
    substitutedForUserId: actor.substitutedForUserId,
    correlationId: context.correlationId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent
  };
  const documentRef = { id: task.documentId, authorId: task.document.authorId, title: task.document.title, number: task.document.number };

  return serializableTransaction(async (tx) => {
    if (input.decision === "APPROVE") {
      // Limit mógł się zmienić po przydzieleniu zadania, a z roli może zdecydować ktoś z niższym limitem.
      // Odczyt w tej samej transakcji Serializable co decyzja: zmiana limitu zatwierdzona przed nią
      // jest tu widoczna, a równoległa czeka na koniec decyzji albo przegrywa konflikt.
      const deciders = await tx.user.findMany({
        where: { id: { in: [context.userId, ...(actor.substitutedForUserId ? [actor.substitutedForUserId] : [])] } },
        select: LIMIT_SELECT
      });
      if (deciders.some((user) => exceedsApprovalLimit(user, task.document))) {
        throw new AppError(403, "Kwota dokumentu przekracza limit akceptacji. Przekaż zadanie osobie z wyższym limitem albo zwróć dokument");
      }
    }
    const taskStatus = input.decision === "APPROVE"
      ? WorkflowTaskStatus.COMPLETED
      : input.decision === "REJECT" ? WorkflowTaskStatus.REJECTED : WorkflowTaskStatus.RETURNED;
    const changed = await tx.workflowTask.updateMany({
      where: { id: taskId, status: WorkflowTaskStatus.OPEN, version: input.expectedVersion },
      data: { status: taskStatus, completedAt: new Date(), version: { increment: 1 } }
    });
    if (changed.count !== 1) throw new AppError(409, "Ktoś właśnie zmienił to zadanie. Odśwież stronę");

    await tx.workflowAction.create({
      data: { taskId, documentId: task.documentId, userId: context.userId, actionType, comment }
    });

    if (input.decision === "REJECT") {
      await cancelRemainingWork(tx, task.instanceId, stage?.id);
      if (stage) await tx.workflowInstanceStage.update({ where: { id: stage.id }, data: { status: "REJECTED", completedAt: new Date() } });
      await tx.workflowInstance.update({ where: { id: task.instanceId }, data: { status: WorkflowInstanceStatus.REJECTED, completedAt: new Date() } });
      const document = await tx.document.update({
        where: { id: task.documentId },
        data: { status: DocumentStatus.REJECTED, currentStepName: null, version: { increment: 1 } }
      });
      await notifyAuthor(tx, documentRef, "DOCUMENT_REJECTED", "Dokument odrzucony", comment);
      await writeAuditInTransaction(tx, {
        ...auditBase,
        entityType: "DOCUMENT",
        entityId: task.documentId,
        action: "DOCUMENT_REJECTED",
        after: { taskId, comment },
        recordVersion: document.version,
        statusBefore: task.document.status,
        statusAfter: document.status
      });
      return { status: "REJECTED" as const, document };
    }

    if (input.decision === "RETURN") {
      // Korekta nie jest zadaniem: autor poprawia dokument i składa go ponownie, a obieg
      // startuje od początku, bo zmieniona treść lub kwota może wymagać innej ścieżki.
      await cancelRemainingWork(tx, task.instanceId, stage?.id);
      if (stage) await tx.workflowInstanceStage.update({ where: { id: stage.id }, data: { status: "RETURNED", completedAt: new Date() } });
      await tx.workflowInstance.update({ where: { id: task.instanceId }, data: { status: WorkflowInstanceStatus.NEEDS_CORRECTION } });
      // Poprawiona treść nie może trafić do odbiorców „do wiadomości”, zanim obieg znów do nich dojdzie.
      await revokeInfoGrants(tx, { instanceStage: { instanceId: task.instanceId } });
      const document = await tx.document.update({
        where: { id: task.documentId },
        data: { status: DocumentStatus.NEEDS_CORRECTION, currentStepName: null, version: { increment: 1 } }
      });
      await notifyAuthor(tx, documentRef, "DOCUMENT_RETURNED", "Dokument do poprawy", comment);
      await writeAuditInTransaction(tx, {
        ...auditBase,
        entityType: "DOCUMENT",
        entityId: task.documentId,
        action: "DOCUMENT_RETURNED",
        after: { taskId, comment },
        recordVersion: document.version,
        statusBefore: task.document.status,
        statusAfter: document.status
      });
      return { status: "NEEDS_CORRECTION" as const, document };
    }

    let stageCompleted = true;
    if (stage) {
      const counts = await tx.workflowTask.groupBy({
        by: ["status"],
        where: { instanceStageId: stage.id },
        _count: { _all: true }
      });
      const statuses = counts.flatMap((item) => Array.from({ length: item._count._all }, () => item.status));
      stageCompleted = isStageComplete(normalizeCompletionMode(stage.completionMode), stage.requiredApprovals, statuses);
      if (stageCompleted) {
        const snapshot = stage.configSnapshotJson
          ? JSON.parse(stage.configSnapshotJson) as { exitConditionJson?: string }
          : {};
        if (snapshot.exitConditionJson) {
          const exit = parseConditions(snapshot.exitConditionJson);
          const currentDocument = await tx.document.findUnique({
            where: { id: task.documentId },
            include: { type: true, department: true }
          });
          if (!exit || !currentDocument || !matchesRuleConditions(exit, currentDocument)) {
            throw new AppError(409, "Dokument nie spełnia warunku zakończenia tego etapu. Zwróć go do poprawy");
          }
        }
        await tx.workflowTask.updateMany({
          where: { instanceStageId: stage.id, status: { in: ACTIVE_TASK_STATUSES } },
          data: { status: WorkflowTaskStatus.CANCELLED, completedAt: new Date(), version: { increment: 1 } }
        });
        await tx.workflowInstanceStage.update({ where: { id: stage.id }, data: { status: "COMPLETED", completedAt: new Date() } });
      }
    }

    let nextTasks: WorkflowTask[] = [];
    if (stageCompleted) {
      const openSiblingStages = await tx.workflowInstanceStage.count({
        where: { instanceId: task.instanceId, stageNo: stage?.stageNo, status: { in: ["OPEN", "PENDING"] } }
      });
      if (!openSiblingStages) nextTasks = (await advanceStages(tx, task.instanceId, documentRef, context)).tasks;
    }

    if (nextTasks.length) {
      const document = await tx.document.findUniqueOrThrow({ where: { id: task.documentId } });
      await writeAuditInTransaction(tx, {
        ...auditBase,
        entityType: "WORKFLOW_TASK",
        entityId: taskId,
        action: "TASK_APPROVED",
        after: { documentId: task.documentId, nextTaskIds: nextTasks.map((item) => item.id) },
        recordVersion: document.version
      });
      return { status: "NEXT_STAGE_OPENED" as const, document, nextTasks };
    }

    const remaining = await tx.workflowInstanceStage.count({
      where: { instanceId: task.instanceId, status: { in: ["OPEN", "PENDING"] } }
    });
    if (!remaining) {
      await tx.workflowInstance.update({ where: { id: task.instanceId }, data: { status: WorkflowInstanceStatus.COMPLETED, completedAt: new Date() } });
      const document = await tx.document.update({
        where: { id: task.documentId },
        data: { status: DocumentStatus.APPROVED, currentStepName: null, version: { increment: 1 } }
      });
      await notifyAuthor(tx, documentRef, "DOCUMENT_APPROVED", "Dokument zatwierdzony");
      await writeAuditInTransaction(tx, {
        ...auditBase,
        entityType: "DOCUMENT",
        entityId: task.documentId,
        action: "DOCUMENT_APPROVED",
        after: { taskId },
        recordVersion: document.version,
        statusBefore: task.document.status,
        statusAfter: document.status
      });
      return { status: "APPROVED" as const, document };
    }

    const document = await tx.document.findUniqueOrThrow({ where: { id: task.documentId } });
    await writeAuditInTransaction(tx, {
      ...auditBase,
      entityType: "WORKFLOW_TASK",
      entityId: taskId,
      action: "TASK_APPROVED",
      after: { documentId: task.documentId },
      recordVersion: document.version
    });
    return { status: "STAGE_IN_PROGRESS" as const, document };
  });
}

async function moveTask(
  task: LoadedTask,
  targetUserId: string,
  expectedVersion: number,
  context: RequestContext,
  options: { actionType: string; auditAction: string; comment: string; source: string; substitutedForUserId?: string }
) {
  const documentRef = { authorId: task.document.authorId, title: task.document.title, number: task.document.number };

  return serializableTransaction(async (tx) => {
    // Kwalifikację osoby docelowej (aktywność, rola, limit) sprawdzamy w tej samej transakcji
    // co przypisanie, żeby równoległa zmiana administratora nie została pominięta.
    const target = await tx.user.findUnique({ where: { id: targetUserId }, select: { id: true, isActive: true, firstName: true, lastName: true, role: true, ...LIMIT_SELECT } });
    if (!target?.isActive) throw new AppError(400, "Wskazana osoba nie istnieje lub jej konto jest nieaktywne");
    if (!canDecideTasks(target.role)) throw new AppError(400, "Ta osoba ze względu na swoją rolę nie może podejmować decyzji w obiegu");
    if (target.id === task.document.authorId) throw new AppError(403, "Autor nie może decydować o własnym dokumencie");
    if (exceedsApprovalLimit(target, task.document)) throw new AppError(400, "Kwota dokumentu przekracza limit akceptacji tej osoby");
    if (target.id === task.assignedToId) throw new AppError(400, "To zadanie jest już przypisane do tej osoby");

    const changed = await tx.workflowTask.updateMany({
      where: { id: task.id, status: WorkflowTaskStatus.OPEN, version: expectedVersion },
      data: {
        assignedToId: target.id,
        assignedRole: null,
        delegatedFromId: task.assignedToId ?? context.userId,
        version: { increment: 1 }
      }
    });
    if (changed.count !== 1) throw new AppError(409, "Ktoś właśnie zmienił to zadanie. Odśwież stronę");
    await tx.workflowTaskCandidate.deleteMany({ where: { taskId: task.id } });
    await tx.workflowTaskCandidate.create({ data: { taskId: task.id, userId: target.id, source: options.source } });
    const updated = await tx.workflowTask.findUniqueOrThrow({ where: { id: task.id } });
    await tx.workflowAction.create({
      data: {
        taskId: task.id,
        documentId: task.documentId,
        userId: context.userId,
        actionType: options.actionType,
        comment: `${options.comment} Nowa osoba: ${target.firstName} ${target.lastName}`.trim()
      }
    });
    await notifyTaskOpened(tx, updated, documentRef);
    await writeAuditInTransaction(tx, {
      userId: context.userId,
      substitutedForUserId: options.substitutedForUserId,
      entityType: "WORKFLOW_TASK",
      entityId: task.id,
      action: options.auditAction,
      before: { assignedToId: task.assignedToId, assignedRole: task.assignedRole },
      after: { documentId: task.documentId, assignedToId: target.id },
      correlationId: context.correlationId,
      recordVersion: updated.version,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent
    });
    return updated;
  });
}

export async function delegateTask(taskId: string, input: DelegateInput, context: RequestContext) {
  const task = await loadTaskForDecision(taskId);
  if (!task) throw new AppError(404, "Nie znaleziono zadania");
  if (task.status !== WorkflowTaskStatus.OPEN) throw new AppError(409, "To zadanie jest już zamknięte");
  if (task.document.status !== DocumentStatus.IN_APPROVAL) throw new AppError(409, "Dokument nie czeka już na decyzję");
  const actor = resolveActor(task, context);
  if (!actor.allowed) throw new AppError(403, "To zadanie nie jest przypisane do Ciebie");
  if (isSelfApproval(task, context.userId)) throw new AppError(403, "Nie możesz przekazywać zadania dotyczącego własnego dokumentu");
  if ((task.instanceStage?.canDelegate ?? task.step?.canDelegate ?? true) === false) {
    throw new AppError(403, "Na tym etapie nie można przekazać zadania");
  }
  return moveTask(task, input.delegateToUserId, input.expectedVersion, context, {
    actionType: WorkflowActionType.DELEGATE,
    auditAction: "TASK_DELEGATED",
    comment: "Przekazano zadanie.",
    source: "DELEGATION",
    substitutedForUserId: actor.substitutedForUserId
  });
}

/**
 * Przepisanie zadania przez administratora: wyjście awaryjne, gdy akceptujący odszedł
 * lub jest niedostępny. Administrator nie decyduje za nikogo, tylko wskazuje osobę.
 */
export async function reassignTask(taskId: string, input: ReassignInput, context: RequestContext) {
  const task = await loadTaskForDecision(taskId);
  if (!task) throw new AppError(404, "Nie znaleziono zadania");
  if (task.status !== WorkflowTaskStatus.OPEN) throw new AppError(409, "To zadanie jest już zamknięte");
  if (task.document.status !== DocumentStatus.IN_APPROVAL) throw new AppError(409, "Dokument nie czeka już na decyzję");
  return moveTask(task, input.assignToUserId, input.expectedVersion, context, {
    actionType: WorkflowActionType.DELEGATE,
    auditAction: "TASK_REASSIGNED",
    comment: `Administrator przepisał zadanie: ${input.comment.trim()}.`,
    source: "REASSIGNMENT"
  });
}

/** Jednorazowe przypomnienie o zaległym zadaniu dla osób, które mogą je wykonać, oraz dla autora. */
export async function notifyOverdueTasks() {
  const tasks = await prisma.workflowTask.findMany({
    where: {
      status: WorkflowTaskStatus.OPEN,
      dueAt: { lt: new Date() },
      notifications: { none: { type: "TASK_OVERDUE" } }
    },
    select: { id: true, name: true, documentId: true, document: { select: { authorId: true, title: true, number: true } } },
    take: 200
  });
  for (const task of tasks) {
    await prisma.$transaction(async (tx) => {
      const recipients = await taskRecipients(tx, task.id, task.document.authorId);
      await tx.notification.createMany({
        data: [...recipients, task.document.authorId].map((userId) => ({
          userId,
          documentId: task.documentId,
          taskId: task.id,
          type: "TASK_OVERDUE",
          title: clip(`Po terminie: ${task.document.title}`, 180),
          body: clip(`${task.document.number} · ${task.name}`, 500)
        }))
      });
    });
  }
  return tasks.length;
}
