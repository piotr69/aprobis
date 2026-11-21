import type { DocumentStatus, FormField, Person } from "@/lib/types";

export const statusLabels: Record<DocumentStatus, string> = {
  DRAFT: "Szkic",
  REGISTERED: "Do złożenia",
  IN_APPROVAL: "W akceptacji",
  IN_REVIEW: "W akceptacji",
  NEEDS_CORRECTION: "Do poprawy",
  REJECTED: "Odrzucony",
  PARTIALLY_APPROVED: "W akceptacji",
  APPROVED: "Zatwierdzony",
  WAITING_FOR_SIGNATURE: "Do podpisu",
  SIGNED: "Podpisany",
  CANCELLED: "Wycofany",
  ARCHIVED: "W archiwum",
  OVERDUE: "Po terminie"
};

export const statusTones: Record<DocumentStatus, string> = {
  DRAFT: "neutral",
  REGISTERED: "neutral",
  IN_APPROVAL: "info",
  IN_REVIEW: "info",
  NEEDS_CORRECTION: "warning",
  REJECTED: "danger",
  PARTIALLY_APPROVED: "info",
  APPROVED: "success",
  WAITING_FOR_SIGNATURE: "info",
  SIGNED: "success",
  CANCELLED: "neutral",
  ARCHIVED: "neutral",
  OVERDUE: "danger"
};

/** Statusy, które dokument może dziś osiągnąć: tylko je pokazujemy w filtrach. */
export const filterableStatuses: DocumentStatus[] = ["DRAFT", "IN_APPROVAL", "NEEDS_CORRECTION", "APPROVED", "REJECTED", "CANCELLED", "ARCHIVED"];

export const categoryLabels: Record<string, string> = {
  FINANCIAL: "Finanse",
  CONTRACT: "Umowy",
  HR: "Kadry",
  ADMIN: "Administracja",
  TECHNICAL: "Techniczne",
  QUALITY: "Jakość i zgodność"
};

export const categoryOrder = ["FINANCIAL", "CONTRACT", "HR", "ADMIN", "TECHNICAL", "QUALITY"];

export const assigneeTypeLabels: Record<string, string> = {
  MANAGER: "Przełożony autora",
  DEPARTMENT_MANAGER: "Kierownik działu autora",
  ROLE: "Osoba z wybranej roli",
  USER: "Konkretna osoba",
  DEPARTMENT_ROLE: "Osoba z roli w dziale",
  BOARD: "Zarząd"
};

export const actionLabels: Record<string, string> = {
  SUBMIT: "Złożono do akceptacji",
  APPROVE: "Zatwierdzono",
  REJECT: "Odrzucono",
  RETURN: "Zwrócono do poprawy",
  DELEGATE: "Przekazano zadanie",
  CANCEL: "Wycofano dokument",
  ARCHIVE: "Zarchiwizowano",
  COMMENT: "Dodano komentarz"
};

export function fullName(person?: Pick<Person, "firstName" | "lastName"> | null, fallback = "—") {
  return person ? `${person.firstName} ${person.lastName}`.trim() : fallback;
}

export function initials(name: string) {
  return name.split(" ").filter(Boolean).map((part) => part[0]).join("").slice(0, 2).toLocaleUpperCase("pl-PL");
}

export function money(value?: string | number | null, currency = "PLN") {
  if (value === null || value === undefined || value === "") return "—";
  return new Intl.NumberFormat("pl-PL", { style: "currency", currency }).format(Number(value));
}

export function date(value?: string | null) {
  return value ? new Date(value).toLocaleDateString("pl-PL") : "—";
}

export function dateTime(value?: string | null) {
  return value ? new Date(value).toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" }) : "—";
}

export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isOverdue(dueAt?: string | null) {
  return Boolean(dueAt) && new Date(dueAt!).getTime() < Date.now();
}

/** Opis terminu po ludzku: „dziś”, „za 2 dni”, „3 dni po terminie”. */
export function dueText(dueAt?: string | null) {
  if (!dueAt) return "bez terminu";
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(new Date(dueAt)) - startOfDay(new Date())) / 86_400_000);
  if (isOverdue(dueAt)) {
    if (days === 0) return "dziś, po terminie";
    const late = Math.abs(days);
    return `${late} ${late === 1 ? "dzień" : "dni"} po terminie`;
  }
  if (days === 0) return "dziś";
  if (days === 1) return "jutro";
  return `za ${days} dni`;
}

export function parseData(raw?: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function fieldValueText(field: FormField, value: unknown) {
  if (value === undefined || value === null || value === "") return "—";
  if (field.type === "boolean") return value === true || value === "true" ? "Tak" : "Nie";
  if (field.type === "date") return date(String(value));
  return String(value);
}

/** Tytuł z szablonu typu: tokeny `{klucz}` lub `{Etykieta pola}`. */
export function applyTitleTemplate(template: string, fields: FormField[], data: Record<string, unknown>) {
  return template
    .replace(/\{([^}]+)\}/g, (_match, token: string) => {
      const name = token.trim();
      const field = fields.find((item) => item.key === name || item.label === name);
      return field ? fieldValueText(field, data[field.key]).replace("—", "") : "";
    })
    .replace(/\s+/g, " ")
    .replace(/[\s\-–:,]+$/, "")
    .trim();
}
