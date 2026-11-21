import { Router } from "express";
import { z } from "zod";
import { authenticate, requireCapability } from "../../middleware/auth.js";
import { asyncHandler, AppError, requireParam } from "../../shared/http.js";
import { prisma } from "../../shared/prisma.js";
import { requestAuditContext, writeAuditInTransaction } from "../../shared/audit.js";
import { publicUserSelect } from "../../shared/userSelect.js";
import { canDecideTasks, roleCapabilities } from "../../shared/roles.js";

export const organizationRouter = Router();

const departmentSchema = z.object({
  name: z.string().trim().min(1).max(180),
  code: z.string().trim().min(1).max(40),
  parentDepartmentId: z.string().optional().nullable(),
  managerId: z.string().optional().nullable(),
  isActive: z.boolean().default(true)
});

const departmentPatchSchema = z.object({
  name: z.string().trim().min(1).max(180).optional(),
  code: z.string().trim().min(1).max(40).optional(),
  parentDepartmentId: z.string().optional().nullable(),
  managerId: z.string().optional().nullable(),
  isActive: z.boolean().optional()
});

const substitutionSchema = z.object({
  userId: z.string().min(1).optional(),
  substituteUserId: z.string().min(1),
  validFrom: z.coerce.date(),
  validTo: z.coerce.date()
}).refine((input) => input.validTo > input.validFrom, {
  message: "Koniec zastępstwa musi być późniejszy niż początek",
  path: ["validTo"]
});

organizationRouter.use(authenticate);

organizationRouter.get(
  "/departments",
  asyncHandler(async (_req, res) => {
    const departments = await prisma.department.findMany({
      orderBy: { name: "asc" },
      include: {
        manager: { select: publicUserSelect },
        parent: { select: { id: true, name: true, code: true } },
        _count: { select: { users: true } }
      }
    });
    res.json(departments);
  })
);

organizationRouter.post(
  "/departments",
  requireCapability("manageUsers"),
  asyncHandler(async (req, res) => {
    const input = departmentSchema.parse(req.body);
    const department = await prisma.$transaction(async (tx) => {
      const created = await tx.department.create({ data: { ...input, code: input.code.toUpperCase() } });
      await writeAuditInTransaction(tx, {
        userId: req.user!.id,
        entityType: "DEPARTMENT",
        entityId: created.id,
        action: "CREATE",
        after: created,
        ...requestAuditContext(req)
      });
      return created;
    });
    res.status(201).json(department);
  })
);

organizationRouter.patch(
  "/departments/:id",
  requireCapability("manageUsers"),
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    const input = departmentPatchSchema.parse(req.body);
    const department = await prisma.$transaction(async (tx) => {
      const before = await tx.department.findUnique({ where: { id } });
      if (!before) throw new AppError(404, "Nie znaleziono działu");
      const updated = await tx.department.update({
        where: { id },
        data: { ...input, ...(input.code ? { code: input.code.toUpperCase() } : {}) }
      });
      await writeAuditInTransaction(tx, {
        userId: req.user!.id,
        entityType: "DEPARTMENT",
        entityId: id,
        action: "UPDATE",
        before,
        after: updated,
        ...requestAuditContext(req)
      });
      return updated;
    });
    res.json(department);
  })
);

organizationRouter.get(
  "/positions",
  asyncHandler(async (_req, res) => {
    res.json(await prisma.position.findMany({ orderBy: [{ level: "asc" }, { name: "asc" }] }));
  })
);

organizationRouter.get(
  "/substitutions",
  asyncHandler(async (req, res) => {
    // Nieobecności innych osób to dane pracownicze: każdy widzi tylko te, które go dotyczą.
    const scope = roleCapabilities(req.user!.role).manageUsers
      ? {}
      : { OR: [{ userId: req.user!.id }, { substituteUserId: req.user!.id }] };
    const substitutions = await prisma.userSubstitution.findMany({
      where: { isActive: true, validTo: { gte: new Date() }, ...scope },
      include: { user: { select: publicUserSelect }, substituteUser: { select: publicUserSelect } },
      orderBy: { validFrom: "asc" }
    });
    res.json(substitutions);
  })
);

organizationRouter.post(
  "/substitutions",
  asyncHandler(async (req, res) => {
    const input = substitutionSchema.parse(req.body);
    const userId = input.userId ?? req.user!.id;
    if (userId !== req.user!.id && !roleCapabilities(req.user!.role).manageUsers) {
      throw new AppError(403, "Możesz ustawić zastępstwo tylko za siebie");
    }
    if (userId === input.substituteUserId) throw new AppError(400, "Nie można zastępować samego siebie");
    const substitute = await prisma.user.findUnique({ where: { id: input.substituteUserId }, select: { isActive: true, role: true } });
    if (!substitute?.isActive) throw new AppError(400, "Zastępca nie istnieje lub ma nieaktywne konto");
    if (!canDecideTasks(substitute.role)) throw new AppError(400, "Ta osoba ze względu na swoją rolę nie może zastępować w decyzjach");
    const substitution = await prisma.$transaction(async (tx) => {
      const created = await tx.userSubstitution.create({
        data: { userId, substituteUserId: input.substituteUserId, validFrom: input.validFrom, validTo: input.validTo, scope: "ALL" },
        include: { user: { select: publicUserSelect }, substituteUser: { select: publicUserSelect } }
      });
      await writeAuditInTransaction(tx, {
        userId: req.user!.id,
        entityType: "USER_SUBSTITUTION",
        entityId: created.id,
        action: "CREATE",
        after: { userId, substituteUserId: input.substituteUserId, validFrom: input.validFrom, validTo: input.validTo },
        ...requestAuditContext(req)
      });
      return created;
    });
    res.status(201).json(substitution);
  })
);

organizationRouter.delete(
  "/substitutions/:id",
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    const existing = await prisma.userSubstitution.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, "Nie znaleziono zastępstwa");
    if (existing.userId !== req.user!.id && !roleCapabilities(req.user!.role).manageUsers) {
      throw new AppError(403, "Możesz odwołać tylko własne zastępstwo");
    }
    await prisma.$transaction(async (tx) => {
      await tx.userSubstitution.update({ where: { id }, data: { isActive: false } });
      await writeAuditInTransaction(tx, {
        userId: req.user!.id,
        entityType: "USER_SUBSTITUTION",
        entityId: id,
        action: "CANCELLED",
        ...requestAuditContext(req)
      });
    });
    res.status(204).end();
  })
);
