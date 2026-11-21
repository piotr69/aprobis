import { Router } from "express";
import type { AppConfig } from "@prisma/client";
import { z } from "zod";
import { authenticate, requireCapability } from "../../middleware/auth.js";
import { APP_VERSION_KEY, versionInfo } from "../../shared/appVersion.js";
import { requestAuditContext, writeAuditInTransaction } from "../../shared/audit.js";
import {
  CONFIG_SECRET_MASK,
  CONFIG_TYPES,
  clearConfigCache,
  getConfigValues,
  isSecretConfigKey,
  maskConfigValue,
  normalizeConfigValue,
  validateConfigValue
} from "../../shared/config.js";
import { AppError, asyncHandler, requireParam } from "../../shared/http.js";
import { prisma } from "../../shared/prisma.js";

/**
 * Administracja → Konfiguracja. Sekrety nigdy nie wychodzą
 * z bazy: lista, odpowiedzi na zapis i audyt dostają maskę. Wersję widzi każdy zalogowany.
 */
export const configRouter = Router();

configRouter.use(authenticate);

configRouter.get(
  "/version",
  asyncHandler(async (_req, res) => {
    res.set("Cache-Control", "no-store").json(await versionInfo());
  })
);

/** Ukryta gra: frontend pyta przed każdym otwarciem. Brak klucza albo inna wartość niż "true" = wyłączona. */
export const EASTER_EGG_KEY = "EASTER_EGG_ENABLED";

configRouter.get(
  "/easter-egg",
  asyncHandler(async (_req, res) => {
    const values = await getConfigValues([EASTER_EGG_KEY]);
    res.set("Cache-Control", "no-store").json({ enabled: values[EASTER_EGG_KEY] === "true" });
  })
);

configRouter.use(requireCapability("manageConfig"));

/** Klucze ustawiane przez program, nie przez administratora. */
const READ_ONLY_KEYS = new Set([APP_VERSION_KEY]);

const userSelect = { select: { firstName: true, lastName: true } } as const;

function present(row: AppConfig & { updatedBy?: { firstName: string; lastName: string } | null }) {
  return {
    id: row.id,
    key: row.key,
    value: maskConfigValue(row.key, row.value),
    type: row.type,
    category: row.category,
    description: row.description,
    isSystem: row.isSystem,
    isSecret: isSecretConfigKey(row.key),
    isReadOnly: READ_ONLY_KEYS.has(row.key),
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy ?? null
  };
}

/** Stan do audytu: bez sekretów. */
function auditState(row: Pick<AppConfig, "key" | "value" | "type" | "category" | "description">) {
  return { key: row.key, value: maskConfigValue(row.key, row.value), type: row.type, category: row.category, description: row.description };
}

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => text(max).transform((value) => value || null).nullable().optional();
const valueSchema = z.string().max(500).nullable().optional();

const createSchema = z.object({
  key: text(100).regex(/^[A-Za-z0-9_.-]+$/, "Klucz może zawierać litery, cyfry, kropkę, myślnik i podkreślenie").min(1, "Podaj klucz"),
  value: valueSchema,
  type: z.enum(CONFIG_TYPES).default("string"),
  category: optionalText(50),
  description: optionalText(300)
});

const updateSchema = z.object({
  value: valueSchema,
  type: z.enum(CONFIG_TYPES).optional(),
  category: optionalText(50),
  description: optionalText(300)
});

function assertValid(key: string, type: string, value: string | null) {
  const problem = validateConfigValue(key, type, value);
  if (problem) throw new AppError(400, `${key}: ${problem}`);
}

configRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = await prisma.appConfig.findMany({ include: { updatedBy: userSelect }, orderBy: [{ category: "asc" }, { key: "asc" }] });
    res.json(rows.map(present));
  })
);

configRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createSchema.parse(req.body);
    const value = normalizeConfigValue(input.key, input.value);
    if (value?.includes(CONFIG_SECRET_MASK)) throw new AppError(400, "Wartość nie może zawierać maski hasła");
    assertValid(input.key, input.type, value);
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.appConfig.create({
        data: { key: input.key, value, type: input.type, category: input.category ?? null, description: input.description ?? null, isSystem: false, updatedById: req.user!.id },
        include: { updatedBy: userSelect }
      });
      await writeAuditInTransaction(tx, { userId: req.user!.id, entityType: "APP_CONFIG", entityId: row.id, action: "CREATE", after: auditState(row), ...requestAuditContext(req) });
      return row;
    });
    clearConfigCache();
    res.status(201).json(present(created));
  })
);

configRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    const input = updateSchema.parse(req.body);
    const updated = await prisma.$transaction(async (tx) => {
      const before = await tx.appConfig.findUnique({ where: { id } });
      if (!before) throw new AppError(404, "Nie znaleziono klucza");
      if (READ_ONLY_KEYS.has(before.key)) throw new AppError(400, `${before.key} ustawia program przy instalacji. Nie można go zmienić ręcznie.`);

      const data: { value?: string | null; type?: string; category?: string | null; description?: string | null } = {};
      if (input.value !== undefined) {
        const value = normalizeConfigValue(before.key, input.value);
        const secret = isSecretConfigKey(before.key);
        if (secret && value === CONFIG_SECRET_MASK) {
          // Maska odesłana bez zmian znaczy: zostaw dotychczasowe hasło.
        } else if (value?.includes(CONFIG_SECRET_MASK)) {
          throw new AppError(400, "Wartość zawiera maskę hasła. Wpisz pełną nową wartość albo zostaw pole bez zmian.");
        } else if (value !== before.value) {
          data.value = value;
        }
      }
      if (before.isSystem) {
        // Klucz systemowy: zmienia się tylko wartość. Typ i kategoria decydują o walidacji i o tym, jak program go czyta.
        const changesMeta =
          (input.type !== undefined && input.type !== before.type) ||
          (input.category !== undefined && input.category !== before.category) ||
          (input.description !== undefined && input.description !== before.description);
        if (changesMeta) throw new AppError(400, "W kluczu systemowym można zmienić tylko wartość");
      } else {
        if (input.type !== undefined && input.type !== before.type) data.type = input.type;
        if (input.category !== undefined && input.category !== before.category) data.category = input.category;
        if (input.description !== undefined && input.description !== before.description) data.description = input.description;
      }
      if (!Object.keys(data).length) return tx.appConfig.findUniqueOrThrow({ where: { id }, include: { updatedBy: userSelect } });

      assertValid(before.key, data.type ?? before.type, data.value !== undefined ? data.value : before.value);
      const row = await tx.appConfig.update({ where: { id }, data: { ...data, updatedById: req.user!.id }, include: { updatedBy: userSelect } });
      await writeAuditInTransaction(tx, {
        userId: req.user!.id,
        entityType: "APP_CONFIG",
        entityId: id,
        action: "UPDATE",
        before: auditState(before),
        after: auditState(row),
        ...requestAuditContext(req)
      });
      return row;
    });
    clearConfigCache();
    res.json(present(updated));
  })
);

configRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    await prisma.$transaction(async (tx) => {
      const before = await tx.appConfig.findUnique({ where: { id } });
      if (!before) throw new AppError(404, "Nie znaleziono klucza");
      if (before.isSystem) throw new AppError(400, "Nie można usunąć klucza systemowego");
      await tx.appConfig.delete({ where: { id } });
      await writeAuditInTransaction(tx, { userId: req.user!.id, entityType: "APP_CONFIG", entityId: id, action: "DELETE", before: auditState(before), ...requestAuditContext(req) });
    });
    clearConfigCache();
    res.status(204).end();
  })
);
