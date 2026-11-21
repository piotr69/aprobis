import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { authenticate, requireCapability } from "../../middleware/auth.js";
import { asyncHandler, AppError, requireParam } from "../../shared/http.js";
import { prisma } from "../../shared/prisma.js";
import { requestAuditContext, writeAuditInTransaction } from "../../shared/audit.js";

export const documentTypeRouter = Router();

const documentFieldSchema = z.object({
  key: z.string().trim().regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/, "Klucz pola może zawierać tylko litery, cyfry, kropkę, myślnik i podkreślenie").max(100),
  label: z.string().trim().min(1).max(180),
  type: z.enum(["text", "number", "date", "select", "textarea", "boolean"]).default("text"),
  required: z.boolean().default(false),
  searchable: z.boolean().default(false),
  options: z.array(z.string()).optional(),
  placeholder: z.string().max(200).optional()
});

const documentTypeBaseSchema = z.object({
  name: z.string().trim().min(1).max(180),
  code: z.string().trim().min(1).max(60),
  category: z.enum(["FINANCIAL", "CONTRACT", "HR", "ADMIN", "TECHNICAL", "QUALITY"]),
  requiresAmount: z.boolean().default(false),
  requiresContractor: z.boolean().default(false),
  fields: z.array(documentFieldSchema).optional(),
  titleTemplate: z.string().max(240).optional().nullable(),
  // Bez defaultWorkflowId: ścieżkę ustawia publikacja schematu (configureWorkflows), nie edycja formularza.
  isActive: z.boolean().default(true)
});

/** Tokeny szablonu tytułu muszą wskazywać istniejące pola, inaczej tytuł wychodzi pusty. */
function validateFields(input: { fields?: z.infer<typeof documentFieldSchema>[]; titleTemplate?: string | null }, ctx: z.RefinementCtx) {
  const fields = input.fields;
  if (!fields) return;
  const keys = new Set<string>();
  fields.forEach((field, index) => {
    if (keys.has(field.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fields", index, "key"], message: `Klucz „${field.key}” się powtarza` });
    keys.add(field.key);
  });
  for (const [, token] of (input.titleTemplate ?? "").matchAll(/\{([^}]+)\}/g)) {
    const name = token.trim();
    if (!fields.some((field) => field.key === name || field.label === name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["titleTemplate"], message: `Szablon tytułu wskazuje nieistniejące pole „${name}”` });
    }
  }
}

const documentTypeSchema = documentTypeBaseSchema.superRefine(validateFields);
const documentTypePatchSchema = documentTypeBaseSchema.partial().superRefine(validateFields);

function fieldsToCreate(fields: z.infer<typeof documentFieldSchema>[]) {
  return fields.map((field, index) => ({
    key: field.key,
    label: field.label,
    fieldType: field.type,
    sortOrder: index,
    isRequired: field.required,
    isSearchable: field.searchable,
    uiConfigJson: JSON.stringify({ options: field.options, placeholder: field.placeholder })
  }));
}

function fieldDto(field: {
  key: string; label: string; fieldType: string; isRequired: boolean; isSearchable: boolean; uiConfigJson: string | null;
}) {
  let ui: { options?: string[]; placeholder?: string } = {};
  try { ui = field.uiConfigJson ? JSON.parse(field.uiConfigJson) : {}; } catch { ui = {}; }
  return {
    key: field.key,
    label: field.label,
    type: field.fieldType,
    required: field.isRequired,
    searchable: field.isSearchable,
    options: ui.options,
    placeholder: ui.placeholder
  };
}

function legacyFields(raw: string | null) {
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

/**
 * Nowa wersja typu to kopia całości: reguły walidacji i wymagania załączników przechodzą
 * ze starej wersji, a reguły pól są przepinane po kluczu. Bez tego zwykła edycja formularza
 * po cichu zdejmowała ograniczenia z nowych dokumentów.
 */
async function createNextVersion(
  tx: Prisma.TransactionClient,
  documentTypeId: string,
  fields: z.infer<typeof documentFieldSchema>[],
  titleTemplate: string | null | undefined
) {
  const latest = await tx.documentTypeVersion.findFirst({
    where: { documentTypeId },
    orderBy: { version: "desc" },
    include: { fields: true, validationRules: true, attachmentRequirements: true }
  });
  const created = await tx.documentTypeVersion.create({
    data: {
      documentTypeId,
      version: (latest?.version ?? 0) + 1,
      status: "DRAFT",
      titleTemplate,
      fields: { create: fieldsToCreate(fields) }
    },
    include: { fields: { orderBy: { sortOrder: "asc" } } }
  });
  if (latest) {
    const oldKeys = new Map(latest.fields.map((field) => [field.id, field.key]));
    const newIds = new Map(created.fields.map((field) => [field.key, field.id]));
    for (const rule of latest.validationRules) {
      const fieldKey = rule.fieldDefinitionId ? oldKeys.get(rule.fieldDefinitionId) : null;
      // Reguła usuniętego pola znika razem z nim.
      if (rule.fieldDefinitionId && (!fieldKey || !newIds.has(fieldKey))) continue;
      await tx.validationRule.create({
        data: {
          documentTypeVersionId: created.id,
          fieldDefinitionId: fieldKey ? newIds.get(fieldKey) : undefined,
          status: rule.status,
          ruleType: rule.ruleType,
          configJson: rule.configJson,
          message: rule.message,
          sortOrder: rule.sortOrder
        }
      });
    }
    for (const requirement of latest.attachmentRequirements) {
      await tx.attachmentRequirement.create({
        data: {
          documentTypeVersionId: created.id,
          key: requirement.key,
          label: requirement.label,
          status: requirement.status,
          minCount: requirement.minCount,
          maxCount: requirement.maxCount,
          allowedMimeTypesJson: requirement.allowedMimeTypesJson,
          maxSizeBytes: requirement.maxSizeBytes
        }
      });
    }
  }
  return created;
}

documentTypeRouter.use(authenticate);

documentTypeRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const types = await prisma.documentType.findMany({
      include: {
        versions: {
          orderBy: { version: "desc" },
          include: { fields: { orderBy: { sortOrder: "asc" } } }
        }
      },
      orderBy: [{ category: "asc" }, { name: "asc" }]
    });
    res.json(types.map(({ fieldsJson, versions, ...type }) => {
      const published = versions.find((version) => version.status === "PUBLISHED");
      const draft = versions.find((version) => version.status === "DRAFT");
      return {
        ...type,
        fields: published ? published.fields.map(fieldDto) : legacyFields(fieldsJson),
        publishedVersion: published ? { id: published.id, version: published.version, publishedAt: published.publishedAt } : null,
        draftVersion: draft ? { id: draft.id, version: draft.version, fields: draft.fields.map(fieldDto) } : null
      };
    }));
  })
);

documentTypeRouter.post(
  "/",
  requireCapability("configureDocumentTypes"),
  asyncHandler(async (req, res) => {
    const { fields = [], ...input } = documentTypeSchema.parse(req.body);
    const type = await prisma.$transaction(async (tx) => {
      const created = await tx.documentType.create({ data: { ...input, code: input.code.toUpperCase(), fieldsJson: JSON.stringify(fields) } });
      const version = await createNextVersion(tx, created.id, fields, input.titleTemplate);
      await writeAuditInTransaction(tx, {
        userId: req.user!.id,
        entityType: "DOCUMENT_TYPE",
        entityId: created.id,
        action: "DRAFT_VERSION_CREATED",
        after: { version: version.version },
        ...requestAuditContext(req)
      });
      return { ...created, fields: [], draftVersion: { ...version, fields: version.fields.map(fieldDto) } };
    });
    res.status(201).json(type);
  })
);

documentTypeRouter.patch(
  "/:id",
  requireCapability("configureDocumentTypes"),
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    const { fields, ...input } = documentTypePatchSchema.parse(req.body);
    const result = await prisma.$transaction(async (tx) => {
      const before = await tx.documentType.findUnique({ where: { id } });
      if (!before) throw new AppError(404, "Nie znaleziono typu dokumentu");
      const type = await tx.documentType.update({
        where: { id },
        data: { ...input, ...(input.code ? { code: input.code.toUpperCase() } : {}), ...(fields ? { fieldsJson: JSON.stringify(fields) } : {}) }
      });
      // `null` to świadome wyłączenie szablonu, a brak pola oznacza „bez zmian”.
      const titleTemplate = input.titleTemplate !== undefined ? input.titleTemplate : before.titleTemplate;
      const draftVersion = fields ? await createNextVersion(tx, id, fields, titleTemplate) : null;
      await writeAuditInTransaction(tx, {
        userId: req.user!.id,
        entityType: "DOCUMENT_TYPE",
        entityId: id,
        action: fields ? "DRAFT_VERSION_CREATED" : "UPDATE",
        before: { name: before.name, isActive: before.isActive },
        after: { name: type.name, isActive: type.isActive, draftVersion: draftVersion?.version },
        ...requestAuditContext(req)
      });
      return { ...type, draftVersion: draftVersion ? { ...draftVersion, fields: draftVersion.fields.map(fieldDto) } : null };
    });
    res.json(result);
  })
);

documentTypeRouter.post(
  "/:id/versions/:versionId/publish",
  requireCapability("configureDocumentTypes"),
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    const versionId = requireParam(req.params.versionId, "versionId");
    const published = await prisma.$transaction(async (tx) => {
      const version = await tx.documentTypeVersion.findFirst({ where: { id: versionId, documentTypeId: id } });
      if (!version) throw new AppError(404, "Nie znaleziono wersji typu dokumentu");
      if (version.status !== "DRAFT") throw new AppError(409, "Opublikować można tylko wersję roboczą");
      const unsupported = await tx.attachmentRequirement.count({
        where: { documentTypeVersionId: versionId, AND: [{ status: { not: null } }, { status: { not: "SUBMIT" } }] }
      });
      if (unsupported) throw new AppError(400, "Wymagania załączników obowiązują przy składaniu dokumentu. Usuń wymagania przypisane do innej fazy");
      // Starsze wersje zostają: dokumenty utworzone na nich nadal z nich korzystają.
      await tx.documentTypeVersion.updateMany({ where: { documentTypeId: id, status: "PUBLISHED" }, data: { status: "RETIRED" } });
      const updated = await tx.documentTypeVersion.update({
        where: { id: versionId },
        data: { status: "PUBLISHED", publishedAt: new Date() },
        include: { fields: { orderBy: { sortOrder: "asc" } } }
      });
      await writeAuditInTransaction(tx, {
        userId: req.user!.id,
        entityType: "DOCUMENT_TYPE_VERSION",
        entityId: versionId,
        action: "PUBLISHED",
        after: { documentTypeId: id, version: updated.version },
        ...requestAuditContext(req)
      });
      return updated;
    });
    res.json({ ...published, fields: published.fields.map(fieldDto) });
  })
);
