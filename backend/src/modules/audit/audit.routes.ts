import { Router } from "express";
import { z } from "zod";
import { authenticate, requireCapability } from "../../middleware/auth.js";
import { asyncHandler } from "../../shared/http.js";
import { prisma } from "../../shared/prisma.js";
import { publicUserSelect } from "../../shared/userSelect.js";

export const auditRouter = Router();

auditRouter.use(authenticate);

auditRouter.get(
  "/",
  requireCapability("viewAudit"),
  asyncHandler(async (req, res) => {
    const take = z.coerce.number().int().min(1).max(500).default(100).parse(req.query.take);
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const logs = await prisma.auditLog.findMany({
      where: search
        ? { OR: [{ action: { contains: search } }, { entityType: { contains: search } }, { entityId: { contains: search } }] }
        : {},
      include: { user: { select: publicUserSelect } },
      orderBy: { createdAt: "desc" },
      take
    });
    res.json(logs);
  })
);
