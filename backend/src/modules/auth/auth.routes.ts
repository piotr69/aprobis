import { Router, type Request } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { authenticate } from "../../middleware/auth.js";
import { asyncHandler, AppError } from "../../shared/http.js";
import { logger } from "../../shared/logger.js";
import { prisma } from "../../shared/prisma.js";
import { requestAuditContext, writeAuditInTransaction } from "../../shared/audit.js";
import {
  generateResetToken,
  hashResetToken,
  isWithinLockout,
  LOCKOUT_DURATION_MS,
  LOGIN_RATE_LIMIT,
  MAX_LOGIN_ATTEMPTS,
  RESET_RATE_LIMIT
} from "../../shared/loginPolicy.js";
import { getSmtpSettings, sendMail } from "../../shared/mailer.js";
import { rateLimit } from "../../shared/rateLimit.js";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "../../shared/password.js";
import { SystemRole, type SystemRole as SystemRoleType } from "../../shared/domain.js";
import { canDecideTasks, ROLE_DEFINITIONS } from "../../shared/roles.js";
import {
  clearSessionCookie,
  createSessionToken,
  hashSessionToken,
  SESSION_TTL_MS,
  setSessionCookie
} from "../../shared/session.js";
import { passwordSchema } from "../../shared/passwordPolicy.js";

export const authRouter = Router();

/** Limit na parę adres + konto: pomyłki jednej osoby nie blokują całego biura za jednym NAT-em. */
function identifierKey(prefix: string, req: Request) {
  const body = (req.body ?? {}) as { identifier?: unknown; email?: unknown };
  const identifier = typeof body.identifier === "string" ? body.identifier : typeof body.email === "string" ? body.email : "";
  return `${prefix}:${req.ip ?? "unknown"}:${identifier.trim().toLowerCase()}`.slice(0, 200);
}

const loginRateLimiter = rateLimit({
  ...LOGIN_RATE_LIMIT,
  key: (req) => identifierKey("login", req),
  message: "Zbyt wiele prób logowania. Spróbuj ponownie za chwilę."
});

const resetRateLimiter = rateLimit({
  ...RESET_RATE_LIMIT,
  key: (req) => identifierKey("reset", req),
  message: "Zbyt wiele prób. Odczekaj kilka minut i spróbuj ponownie."
});

const loginSchema = z.object({
  identifier: z.string().trim().min(1).optional(),
  email: z.string().trim().min(1).optional(),
  password: z.string().min(1)
}).refine((input) => input.identifier || input.email, {
  message: "Podaj login lub e-mail",
  path: ["identifier"]
});

/** E-mail i login są wymienne; collation MSSQL ignoruje wielkość liter. */
function findUserByIdentifier(identifier: string) {
  return prisma.user.findFirst({ where: { OR: [{ email: identifier }, { login: identifier }] } });
}

/** Profil zalogowanego: frontend bierze z niego uprawnienia, nie trzyma własnej macierzy ról. */
async function loadProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      department: { select: { id: true, name: true, code: true } },
      position: { select: { id: true, name: true } },
      manager: { select: { id: true, firstName: true, lastName: true } }
    }
  });
  if (!user?.isActive) throw new AppError(401, "Konto jest nieaktywne");
  const now = new Date();
  const substitutions = await prisma.userSubstitution.findMany({
    where: { substituteUserId: userId, isActive: true, scope: "ALL", validFrom: { lte: now }, validTo: { gte: now } },
    select: { validTo: true, user: { select: { id: true, firstName: true, lastName: true, role: true, isActive: true } } }
  });
  const role = (Object.values(SystemRole).includes(user.role as SystemRoleType) ? user.role : SystemRole.EMPLOYEE) as SystemRoleType;
  return {
    id: user.id,
    email: user.email,
    login: user.login,
    firstName: user.firstName,
    lastName: user.lastName,
    role,
    roleLabel: ROLE_DEFINITIONS[role].label,
    capabilities: ROLE_DEFINITIONS[role].capabilities,
    approvalLimitAmount: user.approvalLimitAmount,
    approvalLimitCurrency: user.approvalLimitCurrency,
    department: user.department,
    position: user.position,
    manager: user.manager,
    actingFor: substitutions
      .filter((item) => item.user.isActive && canDecideTasks(item.user.role))
      .map((item) => ({ id: item.user.id, firstName: item.user.firstName, lastName: item.user.lastName, validTo: item.validTo }))
  };
}

const INVALID_CREDENTIALS = `Nieprawidłowy login lub hasło. Po ${MAX_LOGIN_ATTEMPTS} błędnych próbach konto zostanie tymczasowo zablokowane`;
const ACCOUNT_LOCKED = "Konto jest tymczasowo zablokowane po nieudanych próbach logowania. Odczekaj około 15 minut albo ustaw nowe hasło przez „Nie pamiętam hasła”";

authRouter.post(
  "/login",
  loginRateLimiter,
  asyncHandler(async (req, res) => {
    const input = loginSchema.parse(req.body);
    const user = await findUserByIdentifier(input.identifier ?? input.email ?? "");

    if (!user) {
      // Ten sam czas odpowiedzi co przy złym haśle: czas nie może zdradzać, czy konto istnieje.
      await verifyAgainstDummy(input.password);
      // Wpisanego tekstu nie zapisujemy: ludzie czasem wpisują hasło w pole loginu.
      logger.warn("Nieudane logowanie: nie ma takiego konta", { ip: req.ip });
      throw new AppError(401, INVALID_CREDENTIALS, { code: "INVALID_CREDENTIALS" });
    }
    if (!user.isActive) {
      logger.warn("Nieudane logowanie: konto wyłączone", { userId: user.id, login: user.login, ip: req.ip });
      throw new AppError(401, "To konto zostało wyłączone. Skontaktuj się z administratorem", { code: "ACCOUNT_INACTIVE" });
    }
    if (isWithinLockout(user)) {
      logger.warn("Nieudane logowanie: konto zablokowane", { userId: user.id, login: user.login, ip: req.ip });
      throw new AppError(401, ACCOUNT_LOCKED, { code: "ACCOUNT_LOCKED" });
    }

    // Blokada wygasła: zaczynamy liczyć od nowa.
    if (user.lockedAt) {
      await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0, lockedAt: null } });
    }

    if (!(await verifyPassword(user.passwordHash, input.password))) {
      // Atomowy licznik: równoległe nieudane próby nie mogą się zgubić.
      const updated = await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: { increment: 1 } },
        select: { failedLoginAttempts: true }
      });
      if (updated.failedLoginAttempts >= MAX_LOGIN_ATTEMPTS) {
        await prisma.user.update({ where: { id: user.id }, data: { lockedAt: new Date() } });
        logger.warn("Konto zablokowane po nieudanych próbach logowania", { userId: user.id, login: user.login, ip: req.ip });
        throw new AppError(401, ACCOUNT_LOCKED, { code: "ACCOUNT_LOCKED" });
      }
      logger.warn("Nieudane logowanie: złe hasło", { userId: user.id, login: user.login, attempts: updated.failedLoginAttempts, ip: req.ip });
      throw new AppError(401, INVALID_CREDENTIALS, { code: "INVALID_CREDENTIALS" });
    }

    const token = createSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    await prisma.$transaction(async (tx) => {
      // Hasło sprawdziliśmy przed transakcją. Zapis warunkowy na zweryfikowanym skrócie i stanie
      // konta: reset, wyłączenie albo blokada zatwierdzone w międzyczasie unieważniają tę próbę.
      // Inaczej stare hasło dałoby sesję po resecie.
      const current = await tx.user.updateMany({
        where: {
          id: user.id,
          passwordHash: user.passwordHash,
          isActive: true,
          OR: [
            { lockedAt: null },
            { failedLoginAttempts: { lt: MAX_LOGIN_ATTEMPTS } },
            { lockedAt: { lte: new Date(Date.now() - LOCKOUT_DURATION_MS) } }
          ]
        },
        data: { failedLoginAttempts: 0, lockedAt: null }
      });
      if (current.count !== 1) {
        logger.warn("Nieudane logowanie: konto zmieniło się w trakcie logowania", { userId: user.id, login: user.login, ip: req.ip });
        throw new AppError(401, INVALID_CREDENTIALS, { code: "INVALID_CREDENTIALS" });
      }
      await tx.session.create({
        data: {
          userId: user.id,
          tokenHash: hashSessionToken(token),
          expiresAt,
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"]?.slice(0, 300)
        }
      });
      await writeAuditInTransaction(tx, {
        userId: user.id,
        entityType: "USER",
        entityId: user.id,
        action: "LOGIN",
        ...requestAuditContext(req)
      });
    });
    await prisma.rateLimitBucket.deleteMany({ where: { key: identifierKey("login", req) } });

    setSessionCookie(res, token);
    res.json({ user: await loadProfile(user.id) });
  })
);

authRouter.post(
  "/logout",
  authenticate,
  asyncHandler(async (req, res) => {
    await prisma.$transaction(async (tx) => {
      if (req.user!.sessionId) {
        await tx.session.update({ where: { id: req.user!.sessionId }, data: { revokedAt: new Date() } });
      }
      await writeAuditInTransaction(tx, {
        userId: req.user!.id,
        entityType: "USER",
        entityId: req.user!.id,
        action: "LOGOUT",
        ...requestAuditContext(req)
      });
    });
    clearSessionCookie(res);
    res.status(204).end();
  })
);

authRouter.get(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await loadProfile(req.user!.id));
  })
);

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema
});

authRouter.post(
  "/change-password",
  authenticate,
  rateLimit({ ...RESET_RATE_LIMIT, max: 10, message: "Zbyt wiele prób zmiany hasła. Spróbuj ponownie za chwilę." }),
  asyncHandler(async (req, res) => {
    const input = changePasswordSchema.parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
      throw new AppError(400, "Obecne hasło jest nieprawidłowe");
    }
    if (input.currentPassword === input.newPassword) {
      throw new AppError(400, "Nowe hasło musi różnić się od obecnego");
    }
    const passwordHash = await hashPassword(input.newPassword);
    await prisma.$transaction(async (tx) => {
      // Wcześniejszy link resetu nie może nadpisać hasła ustawionego po jego wydaniu.
      // Warunek na zweryfikowanym skrócie: reset zatwierdzony w międzyczasie wygrywa.
      const changed = await tx.user.updateMany({
        where: { id: user.id, passwordHash: user.passwordHash },
        data: { passwordHash, resetTokenHash: null, resetTokenExpires: null }
      });
      if (changed.count !== 1) throw new AppError(409, "Hasło zostało właśnie zmienione w innym miejscu. Zaloguj się ponownie");
      // Wszystkie sesje, także bieżąca: po zmianie hasła użytkownik loguje się ponownie.
      await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await writeAuditInTransaction(tx, {
        userId: user.id,
        entityType: "USER",
        entityId: user.id,
        action: "PASSWORD_CHANGED",
        ...requestAuditContext(req)
      });
    });
    clearSessionCookie(res);
    res.status(204).end();
  })
);

const resetRequestSchema = z.object({ identifier: z.string().trim().min(1).max(255) });

/**
 * Prośba o link do nowego hasła. Odpowiedź jest zawsze taka sama, także przy błędzie wysyłki:
 * nie może zdradzać, czy konto istnieje. Problemy z pocztą widać w logu serwera.
 */
authRouter.post(
  "/password-reset",
  resetRateLimiter,
  asyncHandler(async (req, res) => {
    const { identifier } = resetRequestSchema.parse(req.body);
    try {
      const user = await findUserByIdentifier(identifier);
      if (user?.isActive) {
        const { token, tokenHash, expiresAt } = generateResetToken();
        await prisma.user.update({ where: { id: user.id }, data: { resetTokenHash: tokenHash, resetTokenExpires: expiresAt } });
        const url = `${env.FRONTEND_URL.replace(/\/$/, "")}/reset-hasla/${token}`;
        const smtp = await getSmtpSettings();
        if (smtp) {
          await sendMail(smtp, {
            to: user.email,
            subject: "Aprobis: ustawienie nowego hasła",
            text: `Dzień dobry,\n\notrzymaliśmy prośbę o ustawienie nowego hasła do Twojego konta.\nAby je ustawić, otwórz link (ważny przez 1 godzinę):\n\n${url}\n\nJeśli to nie Ty, zignoruj tę wiadomość. Hasło pozostanie bez zmian.`
          });
        } else if (env.NODE_ENV !== "production") {
          // Lokalnie bez serwera poczty link trafia do logu, żeby dało się przejść całą ścieżkę.
          logger.info("Brak SMTP: link do nowego hasła tylko w logu (tryb lokalny)", { url });
        } else {
          logger.error("Brak SMTP: nie wysłano linku do nowego hasła", { userId: user.id });
        }
      }
    } catch (error) {
      logger.error("Nie udało się wysłać linku do nowego hasła", { error: error instanceof Error ? error.message : String(error) });
    }
    res.json({ ok: true });
  })
);

const resetConfirmSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/, "Link jest nieprawidłowy"),
  password: passwordSchema
});

const INVALID_RESET_LINK = "Link jest nieprawidłowy lub wygasł. Poproś o nowy";

authRouter.post(
  "/password-reset/confirm",
  asyncHandler(async (req, res) => {
    const { token, password } = resetConfirmSchema.parse(req.body);
    const tokenHash = hashResetToken(token);
    const user = await prisma.user.findFirst({
      where: { resetTokenHash: tokenHash, resetTokenExpires: { gt: new Date() }, isActive: true },
      select: { id: true }
    });
    if (!user) throw new AppError(400, INVALID_RESET_LINK);
    const passwordHash = await hashPassword(password);
    await prisma.$transaction(async (tx) => {
      // Warunek na skrót tokenu: link działa raz, także przy dwóch równoległych użyciach.
      const consumed = await tx.user.updateMany({
        where: { id: user.id, resetTokenHash: tokenHash },
        data: { passwordHash, resetTokenHash: null, resetTokenExpires: null, failedLoginAttempts: 0, lockedAt: null }
      });
      if (consumed.count !== 1) throw new AppError(400, INVALID_RESET_LINK);
      await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await writeAuditInTransaction(tx, {
        userId: user.id,
        entityType: "USER",
        entityId: user.id,
        action: "PASSWORD_RESET",
        ...requestAuditContext(req)
      });
    });
    res.json({ ok: true });
  })
);
