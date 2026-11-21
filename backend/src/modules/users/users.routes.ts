import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { authenticate, requireCapability } from "../../middleware/auth.js";
import { asyncHandler, AppError, requireParam } from "../../shared/http.js";
import { prisma } from "../../shared/prisma.js";
import { requestAuditContext, writeAuditInTransaction } from "../../shared/audit.js";
import { hashPassword } from "../../shared/password.js";
import { loginSchema, passwordSchema } from "../../shared/passwordPolicy.js";
import { publicUserSelect } from "../../shared/userSelect.js";
import { SystemRole } from "../../shared/domain.js";
import { ROLE_DEFINITIONS, roleCapabilities } from "../../shared/roles.js";

export { MIN_PASSWORD_LENGTH, passwordSchema } from "../../shared/passwordPolicy.js";

export const userRouter = Router();

const limitAmountSchema = z.string().trim().regex(/^\d{1,16}(\.\d{1,2})?$/, "Wpisz kwotę limitu, np. 5000");
const limitCurrencySchema = z.enum(["PLN", "EUR", "USD"]);

export const userSchema = z.object({
  email: z.string().trim().email(),
  login: loginSchema.optional().nullable(),
  password: passwordSchema,
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().max(120).default(""),
  role: z.nativeEnum(SystemRole),
  departmentId: z.string().optional().nullable(),
  positionId: z.string().optional().nullable(),
  managerId: z.string().optional().nullable(),
  location: z.string().trim().max(120).optional().nullable(),
  // Brak kwoty oznacza brak limitu.
  approvalLimitAmount: limitAmountSchema.optional().nullable(),
  approvalLimitCurrency: limitCurrencySchema.optional(),
  isActive: z.boolean().default(true)
});

export const patchUserSchema = z.object({
  email: z.string().trim().email().optional(),
  login: loginSchema.optional().nullable(),
  password: passwordSchema.optional(),
  firstName: z.string().trim().min(1).max(120).optional(),
  lastName: z.string().trim().max(120).optional(),
  role: z.nativeEnum(SystemRole).optional(),
  departmentId: z.string().optional().nullable(),
  positionId: z.string().optional().nullable(),
  managerId: z.string().optional().nullable(),
  location: z.string().trim().max(120).optional().nullable(),
  approvalLimitAmount: limitAmountSchema.optional().nullable(),
  approvalLimitCurrency: limitCurrencySchema.optional(),
  isActive: z.boolean().optional(),
  unlock: z.boolean().optional()
});

/** Pętla w drzewie przełożonych uniemożliwiłaby eskalację akceptacji. */
async function assertValidManager(tx: Prisma.TransactionClient, userId: string | null, managerId: string | null | undefined) {
  if (!managerId) return;
  if (managerId === userId) throw new AppError(400, "Użytkownik nie może być swoim przełożonym");
  const visited = new Set<string>();
  let currentId: string | null = managerId;
  while (currentId && !visited.has(currentId)) {
    if (currentId === userId) throw new AppError(400, "Taki wybór utworzy pętlę w strukturze przełożonych");
    visited.add(currentId);
    const manager: { managerId: string | null; isActive: boolean } | null = await tx.user.findUnique({
      where: { id: currentId },
      select: { managerId: true, isActive: true }
    });
    if (!manager) throw new AppError(400, "Wskazany przełożony nie istnieje");
    if (currentId === managerId && !manager.isActive) throw new AppError(400, "Wskazany przełożony ma nieaktywne konto");
    currentId = manager.managerId;
  }
}

/**
 * Login i e-mail są wymienne przy logowaniu i resecie hasła, więc muszą być unikalne
 * krzyżowo: login jednej osoby nie może być e-mailem drugiej.
 */
async function assertIdentifiersFree(tx: Prisma.TransactionClient, ids: { email?: string; login?: string | null }, excludeId?: string) {
  const values = [ids.email, ids.login].filter((value): value is string => Boolean(value));
  if (!values.length) return;
  const other = await tx.user.findFirst({
    where: {
      ...(excludeId ? { id: { not: excludeId } } : {}),
      OR: [{ email: { in: values } }, { login: { in: values } }]
    },
    select: { id: true }
  });
  if (other) throw new AppError(409, "Ten login lub e-mail jest już używany przez inne konto");
}

userRouter.use(authenticate);

userRouter.get(
  "/roles",
  asyncHandler(async (_req, res) => {
    // decideTasks: formularze przekazania i przepisania pokazują tylko osoby, które mogą decydować.
    res.json(Object.values(ROLE_DEFINITIONS).map(({ role, label, description, capabilities }) => ({
      role, label, description, decideTasks: capabilities.decideTasks
    })));
  })
);

userRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const users = await prisma.user.findMany({
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      include: {
        department: { select: { id: true, name: true, code: true } },
        position: { select: { id: true, name: true } },
        manager: { select: publicUserSelect }
      }
    });

    const privileged = roleCapabilities(req.user!.role).viewDirectory;

    res.json(
      users.map((user) => {
        const {
          passwordHash: _passwordHash,
          permissionsJson: _permissionsJson,
          decisionLevel: _decisionLevel,
          resetTokenHash: _resetTokenHash,
          resetTokenExpires: _resetTokenExpires,
          approvalLimitAmount,
          approvalLimitCurrency,
          email,
          login,
          location,
          failedLoginAttempts,
          lockedAt,
          ...safe
        } = user;
        // Pozostali widzą tylko dane potrzebne do prezentacji obiegu i wyboru osoby.
        return privileged
          ? { ...safe, email, login, location, failedLoginAttempts, lockedAt, approvalLimitAmount, approvalLimitCurrency }
          : safe;
      })
    );
  })
);

function toSafeUser<T extends { passwordHash: string; permissionsJson: string | null; resetTokenHash: string | null; resetTokenExpires: Date | null }>(user: T) {
  const { passwordHash: _passwordHash, permissionsJson: _permissionsJson, resetTokenHash: _resetTokenHash, resetTokenExpires: _resetTokenExpires, ...safe } = user;
  return safe;
}

userRouter.post(
  "/",
  requireCapability("manageUsers"),
  asyncHandler(async (req, res) => {
    const input = userSchema.parse(req.body);
    const passwordHash = await hashPassword(input.password);
    const login = input.login?.trim() || null;

    const user = await prisma.$transaction(async (tx) => {
      const role = await tx.role.findUnique({ where: { code: input.role } });
      if (!role?.isActive) throw new AppError(422, "Wybrana rola nie jest skonfigurowana");
      await assertIdentifiersFree(tx, { email: input.email, login });
      await assertValidManager(tx, null, input.managerId);
      const created = await tx.user.create({ data: {
        email: input.email,
        login,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        role: input.role,
        departmentId: input.departmentId ?? undefined,
        positionId: input.positionId ?? undefined,
        managerId: input.managerId ?? undefined,
        location: input.location ?? undefined,
        approvalLimitAmount: input.approvalLimitAmount ?? undefined,
        approvalLimitCurrency: input.approvalLimitCurrency,
        isActive: input.isActive
      }});
      await tx.userRole.create({ data: { userId: created.id, roleId: role.id } });
      await writeAuditInTransaction(tx, {
        userId: req.user!.id,
        entityType: "USER",
        entityId: created.id,
        action: "CREATE",
        after: { email: created.email, role: created.role, approvalLimitAmount: created.approvalLimitAmount },
        ...requestAuditContext(req)
      });
      return created;
    });

    res.status(201).json(toSafeUser(user));
  })
);

userRouter.patch(
  "/:id",
  requireCapability("manageUsers"),
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    const { password, unlock, login, ...userData } = patchUserSchema.parse(req.body);
    const before = await prisma.user.findUnique({ where: { id } });
    if (!before) throw new AppError(404, "Nie znaleziono użytkownika");
    // Administrator nie może odciąć sam siebie: firma zostałaby bez dostępu do konfiguracji.
    if (id === req.user!.id && (userData.isActive === false || (userData.role && userData.role !== before.role))) {
      throw new AppError(409, "Nie możesz zmienić własnej roli ani dezaktywować własnego konta");
    }
    const passwordHash = password ? await hashPassword(password) : undefined;
    const normalizedLogin = login === undefined ? undefined : login?.trim() || null;

    const user = await prisma.$transaction(async (tx) => {
      const role = userData.role ? await tx.role.findUnique({ where: { code: userData.role } }) : null;
      if (userData.role && !role?.isActive) throw new AppError(422, "Wybrana rola nie jest skonfigurowana");
      await assertIdentifiersFree(tx, { email: userData.email, login: normalizedLogin }, id);
      await assertValidManager(tx, id, userData.managerId);
      const clearsLock = Boolean(unlock || password || userData.isActive === true);
      const updated = await tx.user.update({ where: { id }, data: {
        ...userData,
        ...(normalizedLogin !== undefined ? { login: normalizedLogin } : {}),
        passwordHash,
        // Wcześniejszy link resetu nie może nadpisać hasła ustawionego po jego wydaniu.
        ...(passwordHash ? { resetTokenHash: null, resetTokenExpires: null } : {}),
        ...(clearsLock ? { failedLoginAttempts: 0, lockedAt: null } : {})
      }});
      if (role) {
        await tx.userRole.deleteMany({ where: { userId: id } });
        await tx.userRole.create({ data: { userId: id, roleId: role.id } });
      }
      if (password || userData.role || userData.isActive === false) {
        await tx.session.updateMany({ where: { userId: id, revokedAt: null, id: { not: req.user!.sessionId } }, data: { revokedAt: new Date() } });
      }
      await writeAuditInTransaction(tx, {
        userId: req.user!.id,
        entityType: "USER",
        entityId: id,
        action: password ? "UPDATE_WITH_PASSWORD_RESET" : unlock ? "UNLOCK" : "UPDATE",
        before: { email: before.email, role: before.role, isActive: before.isActive, managerId: before.managerId, departmentId: before.departmentId, approvalLimitAmount: before.approvalLimitAmount, approvalLimitCurrency: before.approvalLimitCurrency },
        after: { email: updated.email, role: updated.role, isActive: updated.isActive, managerId: updated.managerId, departmentId: updated.departmentId, approvalLimitAmount: updated.approvalLimitAmount, approvalLimitCurrency: updated.approvalLimitCurrency },
        ...requestAuditContext(req)
      });
      return updated;
    });

    res.json(toSafeUser(user));
  })
);
