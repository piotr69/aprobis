import { Router, type Request } from "express";
import { z } from "zod";
import { authenticate, requireCapability } from "../../middleware/auth.js";
import { asyncHandler, AppError, requireParam } from "../../shared/http.js";
import { prisma } from "../../shared/prisma.js";
import { requestAuditContext } from "../../shared/audit.js";
import { assertDocumentAccess, taskAssignedToUserWhere, workflowActionVisibilityWhere } from "../../shared/access.js";
import { publicUserSelect } from "../../shared/userSelect.js";
import { canDecideTasks } from "../../shared/roles.js";
import { approvalLimitFlags } from "./approvalLimitFlags.js";
import { serializableTransaction } from "../../shared/transactions.js";
import { delegateTask, performDecision, reassignTask } from "./workflow.engine.js";

export const workflowRouter = Router();

workflowRouter.use(authenticate);

function engineContext(req: Request) {
  return { userId: req.user!.id, role: req.user!.role, actingFor: req.user!.actingFor, ...requestAuditContext(req) };
}

workflowRouter.get(
  "/tasks/my",
  asyncHandler(async (req, res) => {
    if (!canDecideTasks(req.user!.role)) {
      res.json([]);
      return;
    }
    const tasks = await prisma.workflowTask.findMany({
      where: {
        status: "OPEN",
        // Własnych dokumentów nikt nie zatwierdza, więc nie zaśmiecają listy osób z tej samej roli.
        document: { authorId: { not: req.user!.id } },
        ...taskAssignedToUserWhere(req.user!)
      },
      select: {
        id: true,
        documentId: true,
        name: true,
        status: true,
        version: true,
        dueAt: true,
        assignedToId: true,
        assignedRole: true,
        assignedTo: { select: publicUserSelect },
        instanceStage: { select: { requiresComment: true, requiresAttachment: true, canDelegate: true, canReturn: true } },
        document: {
          select: {
            id: true,
            number: true,
            title: true,
            amount: true,
            currency: true,
            contractorName: true,
            status: true,
            type: { select: { id: true, name: true, category: true } },
            author: { select: publicUserSelect },
            department: { select: { id: true, name: true, code: true } }
          }
        }
      },
      orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }]
    });

    // Zadanie z roli ponad limit jest dla kogoś innego z tej roli. Przypisane zostaje, bo można
    // je jeszcze przekazać albo zwrócić. Limit liczony jak przy decyzji: w zastępstwie oba.
    const exceeded = await approvalLimitFlags(req.user!, tasks);
    res.json(tasks
      .filter((task) => task.assignedToId || !exceeded.get(task.id))
      .map((task) => ({ ...task, approvalLimitExceeded: exceeded.get(task.id) ?? false })));
  })
);

/** Co zrobiłem osobiście. Liczy się faktyczny wykonawca akcji, a nie rola czy przydział zadania. */
const PERSONAL_ACTION_TYPES = ["SUBMIT", "APPROVE", "RETURN", "REJECT", "DELEGATE", "CANCEL", "ARCHIVE"];

workflowRouter.get(
  "/actions/my",
  asyncHandler(async (req, res) => {
    const limit = z.coerce.number().int().min(1).max(100).default(25).parse(req.query.limit);
    const cursor = typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : undefined;
    const actions = await prisma.workflowAction.findMany({
      where: { userId: req.user!.id, actionType: { in: PERSONAL_ACTION_TYPES } },
      select: {
        id: true,
        actionType: true,
        comment: true,
        createdAt: true,
        task: { select: { name: true } },
        document: {
          select: {
            id: true,
            number: true,
            title: true,
            status: true,
            type: { select: { name: true } },
            tasks: {
              where: { status: "OPEN" },
              select: { id: true, name: true, assignedRole: true, assignedTo: { select: publicUserSelect } },
              orderBy: { order: "asc" }
            }
          }
        }
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });
    const hasNextPage = actions.length > limit;
    const items = hasNextPage ? actions.slice(0, limit) : actions;
    res.json({ items, pageInfo: { hasNextPage, nextCursor: hasNextPage ? items.at(-1)?.id ?? null : null } });
  })
);

workflowRouter.get(
  "/tasks/:id",
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    const found = await prisma.workflowTask.findUnique({ where: { id }, select: { documentId: true } });
    if (!found) throw new AppError(404, "Nie znaleziono zadania");
    // Kontrola i odczyt w jednej transakcji: cofnięty w tym czasie wgląd „do wiadomości” nie pokaże tytułu korekty.
    const task = await serializableTransaction(async (tx) => {
      const document = await assertDocumentAccess(found.documentId, req.user, tx);
      return tx.workflowTask.findUniqueOrThrow({
      where: { id },
      include: {
        assignedTo: { select: publicUserSelect },
        instanceStage: { select: { requiresComment: true, requiresAttachment: true, canDelegate: true, canReturn: true } },
        document: { select: { id: true, number: true, title: true, status: true } },
        // Ta sama reguła co w szczegółach dokumentu: COMMENT powiela notatki wewnętrzne.
        actions: {
          where: workflowActionVisibilityWhere(req.user!, document),
          include: { user: { select: publicUserSelect } },
          orderBy: { createdAt: "asc" }
        }
      }
      });
    });
    res.json(task);
  })
);

const decisionSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT", "RETURN"]),
  comment: z.string().max(4000).optional(),
  expectedVersion: z.number().int().positive()
});

workflowRouter.post(
  "/tasks/:id/decision",
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    const input = decisionSchema.parse(req.body);
    res.json(await performDecision(id, input, engineContext(req)));
  })
);

const delegateSchema = z.object({
  delegateToUserId: z.string().min(1),
  expectedVersion: z.number().int().positive()
});

workflowRouter.post(
  "/tasks/:id/delegate",
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    const input = delegateSchema.parse(req.body);
    res.json(await delegateTask(id, input, engineContext(req)));
  })
);

const reassignSchema = z.object({
  assignToUserId: z.string().min(1),
  comment: z.string().trim().min(3).max(500),
  expectedVersion: z.number().int().positive()
});

workflowRouter.post(
  "/tasks/:id/reassign",
  requireCapability("reassignTasks"),
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    const input = reassignSchema.parse(req.body);
    res.json(await reassignTask(id, input, engineContext(req)));
  })
);
