import { DocumentCategory, SystemRole } from "./domain.js";

/**
 * Role systemu: jedno źródło prawdy o tym, co rola widzi i co może robić.
 *
 * Prawo do decyzji w obiegu NIE wynika z roli, tylko z przypisania zadania — rola
 * decyduje o widoczności dokumentów i dostępie do modułów. Frontend dostaje te same
 * dane przez `/auth/me` i `/users/roles`, więc nie trzyma własnej kopii.
 */
export type DocumentScope =
  | { kind: "ALL" }
  | { kind: "CATEGORIES"; categories: string[] }
  | { kind: "ALL_EXCEPT"; categories: string[] }
  | { kind: "NONE" };

export type RoleCapabilities = {
  createDocuments: boolean;
  decideTasks: boolean;
  archiveDocuments: boolean;
  manageUsers: boolean;
  configureDocumentTypes: boolean;
  configureWorkflows: boolean;
  viewReports: boolean;
  viewDocumentReports: boolean;
  viewAudit: boolean;
  /** Logi techniczne (błędy, poczta, praca w tle). */
  viewSystemLogs: boolean;
  /** Ekran Konfiguracja: poczta i ustawienia systemu. Zawiera hasła, więc tylko administrator. */
  manageConfig: boolean;
  viewDirectory: boolean;
  reassignTasks: boolean;
};

export type RoleDefinition = {
  role: SystemRole;
  label: string;
  description: string;
  scope: DocumentScope;
  capabilities: RoleCapabilities;
};

const none: RoleCapabilities = {
  createDocuments: false,
  decideTasks: false,
  archiveDocuments: false,
  manageUsers: false,
  configureDocumentTypes: false,
  configureWorkflows: false,
  viewReports: false,
  viewDocumentReports: false,
  viewAudit: false,
  viewSystemLogs: false,
  manageConfig: false,
  viewDirectory: false,
  reassignTasks: false
};

const employee: RoleCapabilities = { ...none, createDocuments: true, decideTasks: true };
const manager: RoleCapabilities = { ...employee, viewReports: true };

export const ROLE_DEFINITIONS: Record<SystemRole, RoleDefinition> = {
  EMPLOYEE: {
    role: SystemRole.EMPLOYEE,
    label: "Pracownik",
    description: "Tworzy i składa własne dokumenty, decyduje w zadaniach, które do niego trafią.",
    scope: { kind: "NONE" },
    capabilities: employee
  },
  DEPARTMENT_MANAGER: {
    role: SystemRole.DEPARTMENT_MANAGER,
    label: "Kierownik działu",
    description: "Akceptuje dokumenty podwładnych i widzi złożone dokumenty swojego działu.",
    scope: { kind: "NONE" },
    capabilities: manager
  },
  DIRECTOR: {
    role: SystemRole.DIRECTOR,
    label: "Dyrektor",
    description: "Akceptuje dokumenty wyższego szczebla i widzi wszystkie złożone dokumenty, także kadrowe.",
    scope: { kind: "ALL" },
    capabilities: manager
  },
  BOARD: {
    role: SystemRole.BOARD,
    label: "Zarząd",
    description: "Podejmuje decyzje końcowe i widzi wszystkie złożone dokumenty.",
    scope: { kind: "ALL" },
    capabilities: manager
  },
  ACCOUNTING: {
    role: SystemRole.ACCOUNTING,
    label: "Księgowość",
    description: "Weryfikuje dokumenty finansowe i widzi wszystkie złożone dokumenty finansowe.",
    scope: { kind: "CATEGORIES", categories: [DocumentCategory.FINANCIAL] },
    capabilities: manager
  },
  LEGAL: {
    role: SystemRole.LEGAL,
    label: "Dział prawny",
    description: "Opiniuje umowy i widzi wszystkie złożone dokumenty umowne.",
    scope: { kind: "CATEGORIES", categories: [DocumentCategory.CONTRACT] },
    capabilities: employee
  },
  HR: {
    role: SystemRole.HR,
    label: "Kadry (HR)",
    description: "Weryfikuje i archiwizuje dokumenty kadrowe, widzi wszystkie złożone dokumenty kadrowe.",
    scope: { kind: "CATEGORIES", categories: [DocumentCategory.HR] },
    capabilities: { ...employee, archiveDocuments: true }
  },
  PURCHASING: {
    role: SystemRole.PURCHASING,
    label: "Zakupy",
    description: "Opiniuje zamówienia i zapotrzebowania zakupowe.",
    scope: { kind: "NONE" },
    capabilities: employee
  },
  IT: {
    role: SystemRole.IT,
    label: "IT",
    description: "Opiniuje zakupy i zmiany technologiczne.",
    scope: { kind: "NONE" },
    capabilities: employee
  },
  SECRETARIAT: {
    role: SystemRole.SECRETARIAT,
    label: "Sekretariat",
    description: "Prowadzi kancelarię i archiwizuje zatwierdzone dokumenty poza kadrowymi.",
    scope: { kind: "ALL_EXCEPT", categories: [DocumentCategory.HR] },
    capabilities: { ...employee, archiveDocuments: true }
  },
  AUDITOR: {
    role: SystemRole.AUDITOR,
    label: "Audytor",
    description: "Tylko odczyt: wszystkie dokumenty i raporty. Nie tworzy i nie zatwierdza.",
    scope: { kind: "ALL" },
    // Dziennik zdarzeń i logi widzi wyłącznie administrator (decyzja z 2026-11-06).
    capabilities: { ...none, viewReports: true, viewDocumentReports: true, viewDirectory: true }
  },
  VIEWER: {
    role: SystemRole.VIEWER,
    label: "Tylko podgląd",
    description: "Konto bez prawa tworzenia dokumentów i podejmowania decyzji.",
    scope: { kind: "NONE" },
    capabilities: none
  },
  DICTIONARY_ADMIN: {
    role: SystemRole.DICTIONARY_ADMIN,
    label: "Administrator słowników",
    description: "Utrzymuje typy dokumentów i ich formularze.",
    scope: { kind: "NONE" },
    capabilities: { ...employee, configureDocumentTypes: true, viewDirectory: true }
  },
  SYSTEM_ADMIN: {
    role: SystemRole.SYSTEM_ADMIN,
    label: "Administrator systemu",
    description: "Konfiguruje system i przepisuje zadania. Nie zatwierdza cudzych dokumentów ani nie edytuje ich treści.",
    scope: { kind: "ALL" },
    capabilities: {
      createDocuments: true,
      // Rozdział obowiązków: kto konfiguruje system i przepisuje zadania, ten w nich nie decyduje.
      decideTasks: false,
      archiveDocuments: true,
      manageUsers: true,
      configureDocumentTypes: true,
      configureWorkflows: true,
      viewReports: true,
      viewDocumentReports: true,
      viewAudit: true,
      viewSystemLogs: true,
      manageConfig: true,
      viewDirectory: true,
      reassignTasks: true
    }
  }
};

/** Kto może wykonać zadanie: audytor, podgląd i administrator nigdy nie dostają decyzji. */
export function canDecideTasks(role: string) {
  return ROLE_DEFINITIONS[role as SystemRole]?.capabilities.decideTasks ?? false;
}

export function roleCapabilities(role: SystemRole) {
  return ROLE_DEFINITIONS[role].capabilities;
}

/** Kto archiwizuje: sekretariat poza kadrami, kadry swoje dokumenty, administrator wszystkie. */
export function canArchiveCategory(role: SystemRole, category: string) {
  if (role === SystemRole.SYSTEM_ADMIN) return true;
  if (role === SystemRole.HR) return category === DocumentCategory.HR;
  if (role === SystemRole.SECRETARIAT) return category !== DocumentCategory.HR;
  return false;
}
