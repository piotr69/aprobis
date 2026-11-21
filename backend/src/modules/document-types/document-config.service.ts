import type { Prisma } from "@prisma/client";
import { AppError } from "../../shared/http.js";
import { logger } from "../../shared/logger.js";
import { prisma } from "../../shared/prisma.js";

export type ConfiguredDocumentField = {
  id?: string;
  key: string;
  label: string;
  type: "text" | "number" | "date" | "select" | "textarea" | "boolean";
  required: boolean;
  searchable: boolean;
  options?: string[];
  placeholder?: string;
};

type ValidationPhase = "DRAFT" | "SUBMIT";

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function parseLegacyFields(raw: string | null): ConfiguredDocumentField[] {
  const fields = parseJson<Array<Record<string, unknown>>>(raw, []);
  return fields.flatMap((field, index) => {
    const key = typeof field.key === "string" && field.key.trim() ? field.key.trim() : `field_${index + 1}`;
    const label = typeof field.label === "string" ? field.label.trim() : key;
    if (!label) return [];
    const rawType = typeof field.type === "string" ? field.type : "text";
    const type = ["text", "number", "date", "select", "textarea", "boolean"].includes(rawType)
      ? rawType as ConfiguredDocumentField["type"]
      : "text";
    return [{
      key,
      label,
      type,
      required: field.required === true,
      searchable: field.searchable === true,
      options: Array.isArray(field.options) ? field.options.filter((item): item is string => typeof item === "string") : undefined,
      placeholder: typeof field.placeholder === "string" ? field.placeholder : undefined
    }];
  });
}

export async function loadDocumentTypeConfiguration(typeId: string, typeVersionId?: string | null, options: { allowInactive?: boolean } = {}) {
  const documentType = await prisma.documentType.findUnique({
    where: { id: typeId },
    include: {
      versions: {
        where: typeVersionId ? { id: typeVersionId } : { status: "PUBLISHED" },
        orderBy: { version: "desc" },
        take: 1,
        include: {
          fields: { orderBy: { sortOrder: "asc" } },
          validationRules: { orderBy: { sortOrder: "asc" } },
          attachmentRequirements: true
        }
      }
    }
  });
  if (!documentType) throw new AppError(404, "Nie znaleziono typu dokumentu");
  // Dokument utworzony na wyłączonym typie nadal da się otworzyć; zablokowane są tylko nowe zapisy.
  if (!documentType.isActive && !options.allowInactive) throw new AppError(400, "Ten typ dokumentu jest wyłączony");

  const version = documentType.versions[0];
  const fields: ConfiguredDocumentField[] = version
    ? version.fields.map((field) => {
        const ui = parseJson<{ options?: string[]; placeholder?: string }>(field.uiConfigJson, {});
        return {
          id: field.id,
          key: field.key,
          label: field.label,
          type: ["text", "number", "date", "select", "textarea", "boolean"].includes(field.fieldType)
            ? field.fieldType as ConfiguredDocumentField["type"]
            : "text",
          required: field.isRequired,
          searchable: field.isSearchable,
          options: ui.options,
          placeholder: ui.placeholder
        };
      })
    : parseLegacyFields(documentType.fieldsJson);

  return { documentType, version, fields };
}

export function normalizeDocumentData(fields: ConfiguredDocumentField[], input: Record<string, unknown>) {
  const normalized: Record<string, unknown> = {};
  for (const field of fields) {
    const value = input[field.key] ?? input[field.label];
    if (value !== undefined) normalized[field.key] = value;
  }
  return normalized;
}

function isEmpty(value: unknown) {
  return value === undefined || value === null || (typeof value === "string" && !value.trim());
}

export type DocumentValidationRule = {
  fieldDefinitionId: string | null;
  status: string | null;
  ruleType: string;
  configJson: string;
  message: string | null;
};

/** Czy wartość spełnia regułę. Nieznany `ruleType` nie blokuje zapisu. */
function satisfiesRule(ruleType: string, config: Record<string, unknown>, value: unknown) {
  if (ruleType === "MIN_LENGTH") return String(value).length >= Number(config.value ?? 0);
  if (ruleType === "MAX_LENGTH") return String(value).length <= Number(config.value ?? Number.MAX_SAFE_INTEGER);
  if (ruleType === "REGEX") {
    if (typeof config.pattern !== "string") return true;
    try {
      return new RegExp(config.pattern).test(String(value));
    } catch {
      return false;
    }
  }
  if (ruleType === "MIN") return Number(value) >= Number(config.value);
  if (ruleType === "MAX") return Number(value) <= Number(config.value);
  return true;
}

function appliesInPhase(rule: DocumentValidationRule, phase: ValidationPhase) {
  return !rule.status || rule.status === phase;
}

export function validateConfiguredFields(
  fields: ConfiguredDocumentField[],
  data: Record<string, unknown>,
  phase: ValidationPhase,
  validationRules: DocumentValidationRule[] = [],
  /** Wbudowane atrybuty dokumentu (amount, contractorName…), których nie ma w `fields`. */
  builtInValues: Record<string, unknown> = {}
) {
  const issues: Array<{ field: string; message: string }> = [];
  for (const field of fields) {
    const value = data[field.key];
    if (phase === "SUBMIT" && field.required && isEmpty(value)) {
      issues.push({ field: field.key, message: `Pole „${field.label}” jest wymagane` });
      continue;
    }
    if (isEmpty(value)) continue;
    if (field.type === "number" && !Number.isFinite(Number(value))) {
      issues.push({ field: field.key, message: `Pole „${field.label}” musi być liczbą` });
    }
    if (field.type === "date" && Number.isNaN(Date.parse(String(value)))) {
      issues.push({ field: field.key, message: `Pole „${field.label}” musi zawierać poprawną datę` });
    }
    if (field.type === "boolean" && typeof value !== "boolean") {
      issues.push({ field: field.key, message: `Pole „${field.label}” musi być wartością logiczną` });
    }
    if (field.type === "select" && field.options?.length && !field.options.includes(String(value))) {
      issues.push({ field: field.key, message: `Pole „${field.label}” ma niedozwoloną wartość` });
    }

    for (const rule of validationRules.filter((item) => item.fieldDefinitionId !== null && item.fieldDefinitionId === field.id && appliesInPhase(item, phase))) {
      const config = parseJson<Record<string, unknown>>(rule.configJson, {});
      if (!satisfiesRule(rule.ruleType, config, value)) {
        issues.push({ field: field.key, message: rule.message ?? `Niepoprawna wartość pola „${field.label}”` });
      }
    }
  }

  // Reguły bez fieldDefinitionId obowiązują na poziomie typu dokumentu. Wcześniej
  // porównywano je z field.id i nigdy nie trafiały w żadne pole, więc były po cichu
  // pomijane. Cel wskazuje `configJson.field` — dzięki temu można też walidować
  // wbudowane atrybuty (amount, contractorName), które nie mają definicji pola.
  for (const rule of validationRules.filter((item) => item.fieldDefinitionId === null && appliesInPhase(item, phase))) {
    const config = parseJson<Record<string, unknown>>(rule.configJson, {});
    const targetKey = typeof config.field === "string" && config.field.trim() ? config.field.trim() : null;
    if (!targetKey) {
      logger.warn("Reguła walidacji na poziomie typu nie wskazuje pola (configJson.field) — pominięta", {
        ruleType: rule.ruleType
      });
      continue;
    }
    const value = targetKey in data ? data[targetKey] : builtInValues[targetKey];
    if (isEmpty(value)) continue;
    if (!satisfiesRule(rule.ruleType, config, value)) {
      issues.push({ field: targetKey, message: rule.message ?? `Niepoprawna wartość pola „${targetKey}”` });
    }
  }

  if (issues.length) throw new AppError(400, "Popraw dane dokumentu", { issues });
}

export type AttachmentRequirementRule = { status: string | null; minCount: number; label: string };

/**
 * Braki załączników w danej fazie.
 *
 * `status` zawęża wymaganie do konkretnej fazy — dokładnie jak przy regułach walidacji.
 * Wcześniej pole było ignorowane, więc wymaganie przypisane do innej fazy i tak
 * blokowało wysyłkę dokumentu.
 */
export function collectAttachmentIssues(
  requirements: AttachmentRequirementRule[],
  attachmentCount: number,
  phase: ValidationPhase
) {
  return requirements
    .filter((requirement) => !requirement.status || requirement.status === phase)
    .filter((requirement) => attachmentCount < requirement.minCount)
    .map((requirement) => ({ field: "attachments", message: `Wymagany załącznik: ${requirement.label}` }));
}

export type AttachmentConstraint = AttachmentRequirementRule & {
  maxCount: number | null;
  allowedMimeTypesJson: string | null;
  maxSizeBytes: number | null;
};

/** Ograniczenia górne wymagań: liczba, format i rozmiar plików przeskanowanych jako czyste. */
export function collectAttachmentConstraintIssues(
  requirements: AttachmentConstraint[],
  files: Array<{ mimeType: string; size: number }>,
  phase: ValidationPhase
) {
  const issues: Array<{ field: string; message: string }> = [];
  for (const requirement of requirements.filter((item) => !item.status || item.status === phase)) {
    if (requirement.maxCount !== null && files.length > requirement.maxCount) {
      issues.push({ field: "attachments", message: `${requirement.label}: dozwolone najwyżej ${requirement.maxCount} pliki` });
    }
    const allowed = parseJson<string[]>(requirement.allowedMimeTypesJson, []);
    if (allowed.length && files.some((file) => !allowed.includes(file.mimeType))) {
      issues.push({ field: "attachments", message: `${requirement.label}: niedozwolony format pliku` });
    }
    if (requirement.maxSizeBytes !== null && files.some((file) => file.size > requirement.maxSizeBytes!)) {
      issues.push({ field: "attachments", message: `${requirement.label}: plik jest za duży` });
    }
  }
  return issues;
}

export async function validateDocumentForPhase(
  input: {
    typeId: string;
    typeVersionId?: string | null;
    data: Record<string, unknown>;
    amount?: string | number | null;
    contractorName?: string | null;
    /** Pliki przeskanowane jako czyste: tylko one liczą się do wymagań. */
    cleanFiles?: Array<{ mimeType: string; size: number }>;
  },
  phase: ValidationPhase
) {
  const config = await loadDocumentTypeConfiguration(input.typeId, input.typeVersionId);
  const data = normalizeDocumentData(config.fields, input.data);
  validateConfiguredFields(config.fields, data, phase, config.version?.validationRules ?? [], {
    amount: input.amount,
    contractorName: input.contractorName
  });
  if (phase === "SUBMIT") {
    const issues: Array<{ field: string; message: string }> = [];
    if (config.documentType.requiresAmount && !input.amount) issues.push({ field: "amount", message: "Kwota jest wymagana" });
    if (config.documentType.requiresContractor && !input.contractorName?.trim()) issues.push({ field: "contractorName", message: "Kontrahent jest wymagany" });
    const requirements = config.version?.attachmentRequirements ?? [];
    const files = input.cleanFiles ?? [];
    issues.push(...collectAttachmentIssues(requirements, files.length, phase));
    issues.push(...collectAttachmentConstraintIssues(requirements, files, phase));
    if (issues.length) throw new AppError(400, "Popraw dane dokumentu", { issues });
  }
  return { ...config, data };
}

export async function replaceFieldProjections(
  tx: Prisma.TransactionClient,
  documentId: string,
  fields: ConfiguredDocumentField[],
  data: Record<string, unknown>
) {
  await tx.documentFieldProjection.deleteMany({ where: { documentId } });
  const rows = fields.filter((field) => field.searchable && !isEmpty(data[field.key])).map((field) => {
    const value = data[field.key];
    return {
      documentId,
      fieldKey: field.key,
      stringValue: ["text", "textarea", "select"].includes(field.type) ? String(value) : undefined,
      numberValue: field.type === "number" ? String(value) : undefined,
      dateValue: field.type === "date" ? new Date(String(value)) : undefined,
      boolValue: field.type === "boolean" ? Boolean(value) : undefined
    };
  });
  if (rows.length) await tx.documentFieldProjection.createMany({ data: rows });
}

export function serializeFields(fields: ConfiguredDocumentField[]) {
  return fields.map(({ id: _id, searchable, ...field }) => ({ ...field, searchable }));
}
