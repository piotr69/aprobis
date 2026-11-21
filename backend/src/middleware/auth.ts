import type { NextFunction, Request, Response } from "express";
import { AppError } from "../shared/http.js";
import { logger } from "../shared/logger.js";
import { prisma } from "../shared/prisma.js";
import { SystemRole, type SystemRole as SystemRoleType } from "../shared/domain.js";
import { canDecideTasks, roleCapabilities, type RoleCapabilities } from "../shared/roles.js";
import { hashSessionToken, readCookie, SESSION_COOKIE } from "../shared/session.js";

function parseRole(value: string): SystemRoleType {
  return Object.values(SystemRole).includes(value as SystemRoleType)
    ? (value as SystemRoleType)
    : SystemRole.EMPLOYEE;
}

/**
 * Tylko pełne zastępstwa: zakres inny niż ALL nie jest obsługiwany i nie daje dostępu.
 * Zastępowany musi sam móc decydować: odebranie mu tego prawa działa też na jego zastępców.
 */
async function loadActingFor(userId: string) {
  const now = new Date();
  const substitutions = await prisma.userSubstitution.findMany({
    where: { substituteUserId: userId, isActive: true, scope: "ALL", validFrom: { lte: now }, validTo: { gte: now } },
    select: { user: { select: { id: true, role: true, isActive: true } } }
  });
  return substitutions
    .filter((item) => item.user.isActive && canDecideTasks(item.user.role))
    .map((item) => ({ id: item.user.id, role: parseRole(item.user.role) }));
}

async function loadSessionUser(req: Request) {
  const sessionToken = readCookie(req.headers.cookie, SESSION_COOKIE);
  if (!sessionToken) throw new AppError(401, "Zaloguj się, aby kontynuować");

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(sessionToken) },
    include: { user: true }
  });
  if (!session || session.revokedAt || session.expiresAt <= new Date() || !session.user.isActive) {
    throw new AppError(401, "Sesja wygasła. Zaloguj się ponownie");
  }

  req.user = {
    id: session.user.id,
    email: session.user.email,
    role: parseRole(session.user.role),
    departmentId: session.user.departmentId,
    sessionId: session.id,
    actingFor: await loadActingFor(session.user.id)
  };

  if (Date.now() - session.lastSeenAt.getTime() > 15 * 60 * 1000) {
    // Odświeżenie lastSeenAt jest best-effort — nie wolno mu wywrócić żądania
    // ani procesu (nieobsłużony reject kończy Node.js).
    void prisma.session
      .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
      .catch((error: unknown) => {
        logger.warn("Nie udało się odświeżyć lastSeenAt sesji", {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }
  return session.user;
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    await loadSessionUser(req);
    return next();
  } catch (error) {
    return next(error instanceof AppError ? error : new AppError(401, "Sesja wygasła. Zaloguj się ponownie"));
  }
}

export function requireRoles(...roles: SystemRoleType[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError(401, "Zaloguj się, aby kontynuować"));
    if (!roles.includes(req.user.role)) return next(new AppError(403, "Brak uprawnień do tej operacji"));
    return next();
  };
}

export function requireCapability(capability: keyof RoleCapabilities) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError(401, "Zaloguj się, aby kontynuować"));
    if (!roleCapabilities(req.user.role)[capability]) return next(new AppError(403, "Brak uprawnień do tej operacji"));
    return next();
  };
}
