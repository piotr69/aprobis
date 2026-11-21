import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { authenticate, requireCapability } from "../../middleware/auth.js";
import { asyncHandler } from "../../shared/http.js";
import { prisma } from "../../shared/prisma.js";

export const systemLogRouter = Router();

systemLogRouter.use(authenticate, requireCapability("viewSystemLogs"));

const LEVELS = ["debug", "info", "warn", "error"] as const;

const querySchema = z.object({
  // Lista poziomów po przecinku, np. "warn,error".
  level: z.string().optional().transform((value, ctx) => {
    if (!value) return undefined;
    const levels = value.split(",").map((item) => item.trim()).filter(Boolean);
    if (levels.some((item) => !LEVELS.includes(item as never))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Nieznany poziom logu" });
      return z.NEVER;
    }
    return levels;
  }),
  source: z.enum(["api", "worker"]).optional(),
  search: z.string().trim().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  // Stronicowanie: identyfikator ostatniego pokazanego wpisu. Data nie wystarcza, bo wpisy
  // z jednej paczki mają często tę samą milisekundę.
  cursor: z.string().max(32).optional(),
  take: z.coerce.number().int().min(1).max(500).default(100)
});

systemLogRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    const createdAt: Prisma.DateTimeFilter = {};
    if (query.from) createdAt.gte = query.from;
    if (query.to) createdAt.lte = query.to;
    const where: Prisma.SystemLogWhereInput = {
      ...(query.level ? { level: { in: query.level } } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.search ? { OR: [{ message: { contains: query.search } }, { contextJson: { contains: query.search } }] } : {}),
      ...(Object.keys(createdAt).length ? { createdAt } : {})
    };
    const items = await prisma.systemLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      take: query.take + 1
    });
    const hasMore = items.length > query.take;
    res.json({ items: items.slice(0, query.take), hasMore });
  })
);
