import { Router } from "express";
import { authenticate, requireCapability } from "../../middleware/auth.js";
import { asyncHandler } from "../../shared/http.js";
import { prisma } from "../../shared/prisma.js";
import { publicUserSelect } from "../../shared/userSelect.js";

export const reportsRouter = Router();

reportsRouter.use(authenticate);

// Zagregowane liczniki nie ujawniają pojedynczych dokumentów, więc widzi je szersze grono.
reportsRouter.get(
  "/documents",
  requireCapability("viewReports"),
  asyncHandler(async (_req, res) => {
    const byStatus = await prisma.document.groupBy({ by: ["status"], _count: { id: true } });
    const byType = await prisma.document.groupBy({ by: ["typeId"], _count: { id: true } });
    const types = await prisma.documentType.findMany({ select: { id: true, name: true } });
    const typeMap = new Map(types.map((type) => [type.id, type.name]));

    res.json({
      byStatus: byStatus.map((row) => ({ status: row.status, count: row._count.id })),
      byType: byType
        .map((row) => ({ typeId: row.typeId, type: typeMap.get(row.typeId), count: row._count.id }))
        .sort((first, second) => second.count - first.count)
    });
  })
);

// Raporty wymieniające pojedyncze dokumenty widzą tylko role z pełnym wglądem.
reportsRouter.get(
  "/overdue",
  requireCapability("viewDocumentReports"),
  asyncHandler(async (_req, res) => {
    const tasks = await prisma.workflowTask.findMany({
      where: { status: "OPEN", dueAt: { lt: new Date() } },
      select: {
        id: true,
        name: true,
        dueAt: true,
        version: true,
        assignedRole: true,
        assignedTo: { select: publicUserSelect },
        document: {
          select: {
            id: true,
            number: true,
            title: true,
            type: { select: { name: true } },
            author: { select: publicUserSelect }
          }
        }
      },
      orderBy: { dueAt: "asc" }
    });
    res.json(tasks);
  })
);

reportsRouter.get(
  "/cycle-times",
  requireCapability("viewDocumentReports"),
  asyncHandler(async (_req, res) => {
    const instances = await prisma.workflowInstance.findMany({
      where: { status: "COMPLETED", completedAt: { not: null } },
      select: {
        startedAt: true,
        completedAt: true,
        document: { select: { id: true, number: true, title: true, type: { select: { name: true } } } }
      },
      orderBy: { completedAt: "desc" },
      take: 100
    });

    res.json(instances.map((instance) => ({
      documentId: instance.document.id,
      documentNumber: instance.document.number,
      documentTitle: instance.document.title,
      documentType: instance.document.type.name,
      startedAt: instance.startedAt,
      completedAt: instance.completedAt,
      hours: instance.completedAt
        ? Math.round((instance.completedAt.getTime() - instance.startedAt.getTime()) / 36_000) / 100
        : null
    })));
  })
);
