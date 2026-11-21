export const SystemRole = {
  SYSTEM_ADMIN: "SYSTEM_ADMIN",
  DICTIONARY_ADMIN: "DICTIONARY_ADMIN",
  EMPLOYEE: "EMPLOYEE",
  DEPARTMENT_MANAGER: "DEPARTMENT_MANAGER",
  DIRECTOR: "DIRECTOR",
  BOARD: "BOARD",
  ACCOUNTING: "ACCOUNTING",
  LEGAL: "LEGAL",
  PURCHASING: "PURCHASING",
  HR: "HR",
  AUDITOR: "AUDITOR",
  VIEWER: "VIEWER",
  SECRETARIAT: "SECRETARIAT",
  IT: "IT"
} as const;

export type SystemRole = (typeof SystemRole)[keyof typeof SystemRole];

export const DocumentCategory = {
  FINANCIAL: "FINANCIAL",
  CONTRACT: "CONTRACT",
  HR: "HR",
  ADMIN: "ADMIN",
  TECHNICAL: "TECHNICAL",
  QUALITY: "QUALITY"
} as const;

export type DocumentCategory = (typeof DocumentCategory)[keyof typeof DocumentCategory];

/** Temat komunikatu outboxa: mail do osoby, która dostała zadanie. */
export const TASK_MAIL_TOPIC = "mail.task.assigned";

/** Temat komunikatu outboxa: mail do odbiorcy etapu „do wiadomości”. */
export const STAGE_INFO_MAIL_TOPIC = "mail.stage.info";

/** Rodzaj etapu obiegu. Brak wartości w starych danych i JSON-ach reguł oznacza DECISION. */
export const StageKind = {
  DECISION: "DECISION",
  INFO: "INFO"
} as const;

export type StageKind = (typeof StageKind)[keyof typeof StageKind];

/** Wgląd odbiorcy etapu „do wiadomości”: cofany przy zwrocie do poprawy i anulowaniu obiegu. */
export const StageRecipientStatus = {
  GRANTED: "GRANTED",
  REVOKED: "REVOKED"
} as const;

export const DocumentStatus = {
  DRAFT: "DRAFT",
  REGISTERED: "REGISTERED",
  IN_APPROVAL: "IN_APPROVAL",
  IN_REVIEW: "IN_REVIEW",
  NEEDS_CORRECTION: "NEEDS_CORRECTION",
  REJECTED: "REJECTED",
  PARTIALLY_APPROVED: "PARTIALLY_APPROVED",
  APPROVED: "APPROVED",
  WAITING_FOR_SIGNATURE: "WAITING_FOR_SIGNATURE",
  SIGNED: "SIGNED",
  CANCELLED: "CANCELLED",
  ARCHIVED: "ARCHIVED",
  OVERDUE: "OVERDUE"
} as const;

export const WorkflowInstanceStatus = {
  ACTIVE: "ACTIVE",
  COMPLETED: "COMPLETED",
  REJECTED: "REJECTED",
  NEEDS_CORRECTION: "NEEDS_CORRECTION",
  CANCELLED: "CANCELLED"
} as const;

export const WorkflowTaskStatus = {
  PENDING: "PENDING",
  OPEN: "OPEN",
  COMPLETED: "COMPLETED",
  REJECTED: "REJECTED",
  RETURNED: "RETURNED",
  CANCELLED: "CANCELLED",
  OVERDUE: "OVERDUE",
  DELEGATED: "DELEGATED"
} as const;

export const WorkflowActionType = {
  SUBMIT: "SUBMIT",
  APPROVE: "APPROVE",
  REJECT: "REJECT",
  RETURN: "RETURN",
  COMMENT: "COMMENT",
  DELEGATE: "DELEGATE",
  CORRECT: "CORRECT",
  SIGN: "SIGN",
  ARCHIVE: "ARCHIVE",
  ESCALATE: "ESCALATE"
} as const;

export const WorkflowStepType = {
  REGISTRATION: "REGISTRATION",
  METADATA: "METADATA",
  MANAGER_APPROVAL: "MANAGER_APPROVAL",
  BUSINESS_APPROVAL: "BUSINESS_APPROVAL",
  FINANCIAL_APPROVAL: "FINANCIAL_APPROVAL",
  LEGAL_APPROVAL: "LEGAL_APPROVAL",
  BOARD_APPROVAL: "BOARD_APPROVAL",
  OPINION: "OPINION",
  CORRECTION: "CORRECTION",
  SIGNATURE: "SIGNATURE",
  ACCOUNTING: "ACCOUNTING",
  PUBLICATION: "PUBLICATION",
  ARCHIVE: "ARCHIVE"
} as const;

/**
 * Statusy, w których autor może jeszcze zmieniać treść dokumentu i załączniki.
 * Dokument zarejestrowany ma już numer — treść jest zamknięta, można go tylko wysłać.
 */
export const EDITABLE_DOCUMENT_STATUSES: readonly string[] = [
  DocumentStatus.DRAFT,
  DocumentStatus.NEEDS_CORRECTION
];

/**
 * Statusy, z których wolno uruchomić obieg.
 *
 * Jedno źródło prawdy dla warstwy uprawnień (access.ts) i silnika (workflow.engine.ts).
 * Gdy listy się rozjechały, przycisk „Uruchom workflow" na dokumencie REGISTERED
 * kończył się 403, mimo że silnik taki dokument przyjmował.
 */
export const SUBMITTABLE_DOCUMENT_STATUSES: readonly string[] = [
  DocumentStatus.DRAFT,
  DocumentStatus.REGISTERED,
  DocumentStatus.NEEDS_CORRECTION
];

/** Statusy, z których można wycofać dokument — także w trakcie akceptacji. */
export const CANCELLABLE_DOCUMENT_STATUSES: readonly string[] = [
  DocumentStatus.DRAFT,
  DocumentStatus.REGISTERED,
  DocumentStatus.IN_APPROVAL,
  DocumentStatus.NEEDS_CORRECTION
];

/**
 * Czy dokument można trwale usunąć: tylko szkic, który nigdy nie był wysłany do obiegu.
 * Dokument, który choć raz trafił do akceptujących, ma historię — taki się wycofuje, nie kasuje.
 * Serwis usuwający sprawdza dodatkowo w transakcji brak obiegu, zadań i akcji.
 */
export function isDeletableDraft(document: { status: string; submittedAt: Date | null }) {
  return document.status === DocumentStatus.DRAFT && document.submittedAt === null;
}

export const AssigneeType = {
  AUTHOR: "AUTHOR",
  MANAGER: "MANAGER",
  DEPARTMENT_MANAGER: "DEPARTMENT_MANAGER",
  ROLE: "ROLE",
  USER: "USER",
  DEPARTMENT_ROLE: "DEPARTMENT_ROLE",
  BOARD: "BOARD"
} as const;
