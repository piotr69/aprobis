import type { Prisma } from "@prisma/client";
import type { Request } from "express";
import { AppError } from "./http.js";
import { prisma } from "./prisma.js";
import {
  CANCELLABLE_DOCUMENT_STATUSES,
  DocumentStatus,
  EDITABLE_DOCUMENT_STATUSES,
  isDeletableDraft,
  SUBMITTABLE_DOCUMENT_STATUSES,
  SystemRole
} from "./domain.js";
import { canArchiveCategory, canDecideTasks, ROLE_DEFINITIONS, roleCapabilities } from "./roles.js";

export const DocumentPermission = {
  VIEW: "VIEW",
  EDIT: "EDIT",
  SUBMIT: "SUBMIT",
  COMMENT: "COMMENT",
  UPLOAD: "UPLOAD",
  CANCEL: "CANCEL",
  /** Trwałe usunięcie szkicu. Strażnik sprawdza autorstwo; stan dokumentu sprawdza serwis w transakcji. */
  DELETE: "DELETE"
} as const;

export type DocumentPermission = (typeof DocumentPermission)[keyof typeof DocumentPermission];

type AccessUser = NonNullable<Request["user"]>;

/**
 * Czy uprawnienie przysługuje w danym statusie dokumentu.
 *
 * Wydzielone z `assertDocumentPermission`, żeby reguły dało się przetestować bez bazy.
 * SUBMIT celowo dopuszcza szerszy zbiór statusów niż EDIT/UPLOAD: dokument
 * zarejestrowany ma zamkniętą treść, ale wciąż czeka na uruchomienie obiegu.
 */
export function isPermissionAllowedForStatus(
  permission: DocumentPermission,
  status: string,
  context: { isAuthor: boolean; hasTaskAccess: boolean }
) {
  switch (permission) {
    case DocumentPermission.VIEW:
      return context.isAuthor || context.hasTaskAccess;
    case DocumentPermission.COMMENT:
      return (context.isAuthor || context.hasTaskAccess) && status !== DocumentStatus.ARCHIVED;
    case DocumentPermission.EDIT:
    case DocumentPermission.UPLOAD:
      return context.isAuthor && EDITABLE_DOCUMENT_STATUSES.includes(status);
    case DocumentPermission.SUBMIT:
      return context.isAuthor && SUBMITTABLE_DOCUMENT_STATUSES.includes(status);
    case DocumentPermission.CANCEL:
      return context.isAuthor && CANCELLABLE_DOCUMENT_STATUSES.includes(status);
    default:
      return false;
  }
}

/** Czy rola widzi też cudze szkice: tylko role kontrolne, bo szkic to jeszcze prywatna praca autora. */
export function canSeeAllDocuments(role: string) {
  return role === SystemRole.SYSTEM_ADMIN || role === SystemRole.AUDITOR;
}

/**
 * Zakres widoczności wynikający z samej roli; `null` oznacza brak dodatkowego zakresu.
 * Rola z pełnym zakresem dostaje warunek zawsze prawdziwy dla złożonych dokumentów:
 * Prisma pomija pusty obiekt w OR, więc `{}` nie znaczyłoby „wszystko”, tylko nic.
 */
export function roleScopeWhere(role: SystemRole): Prisma.DocumentWhereInput | null {
  const scope = ROLE_DEFINITIONS[role]?.scope ?? { kind: "NONE" as const };
  switch (scope.kind) {
    case "ALL":
      return { submittedAt: { not: null } };
    case "CATEGORIES":
      return { type: { category: { in: scope.categories } } };
    case "ALL_EXCEPT":
      return { type: { category: { notIn: scope.categories } } };
    default:
      return null;
  }
}

/**
 * Jedyna definicja „kto widzi dokument”: używają jej i lista, i podgląd pojedynczego
 * dokumentu. Osobne reguły dla obu dróg pozwalały otworzyć po identyfikatorze
 * dokument niewidoczny na liście.
 *
 * Tabela DocumentAccessPolicy nie uczestniczy w autoryzacji: nie ma API do jej
 * zarządzania, a warunki polityk nigdy nie były oceniane.
 */
export function documentVisibilityWhere(user: AccessUser, now: Date = new Date()): Prisma.DocumentWhereInput {
  if (canSeeAllDocuments(user.role)) return {};
  return { OR: [participantVisibilityWhere(user, now), infoRecipientWhere(user)] };
}

/**
 * Odbiorca etapu „do wiadomości”: wgląd tylko do odczytu, nadawany, gdy obieg dojdzie do etapu, i cofany
 * przy zwrocie do poprawy lub anulowaniu. Nie przechodzi na zastępców i nie daje decyzji ani komentarzy.
 */
function infoRecipientWhere(user: AccessUser): Prisma.DocumentWhereInput {
  return { stageRecipients: { some: { userId: user.id, status: "GRANTED" } } };
}

/** Wgląd z każdej podstawy poza „do wiadomości”: autor, zadanie, udział w obiegu, przełożony, zakres roli. */
function participantVisibilityWhere(user: AccessUser, now: Date): Prisma.DocumentWhereInput {
  const submittedScopes: Prisma.DocumentWhereInput[] = [
    { author: { managerId: user.id } },
    { department: { managerId: user.id } }
  ];
  const roleScope = roleScopeWhere(user.role);
  if (roleScope) submittedScopes.push(roleScope);
  return {
    OR: [
      { authorId: user.id },
      { tasks: { some: taskAssignedToUserWhere(user, now) } },
      // Kto sam działał w obiegu, zachowuje wgląd także po końcu zastępstwa lub przekazaniu zadania.
      { actions: { some: { userId: user.id } } },
      // Fakt złożenia, a nie bieżący status: wycofany szkic, którego nikt nie widział, zostaje prywatny.
      { submittedAt: { not: null }, OR: submittedScopes }
    ]
  };
}

/**
 * Warunek Prisma dla aktywnego członkostwa w grupie — obie granice ważności.
 * Bez `validFrom` członek zapisany „na przyszłość" mógłby działać już teraz.
 */
export function activeGroupMembershipWhere(userId: string, now: Date = new Date()): Prisma.GroupMemberWhereInput {
  return {
    userId,
    validFrom: { lte: now },
    OR: [{ validTo: null }, { validTo: { gte: now } }]
  };
}

export function identityTaskConditions(id: string, role: string, now: Date): Prisma.WorkflowTaskWhereInput[] {
  return [
    { assignedToId: id },
    { assignedToId: null, assignedRole: role },
    // Zadanie przypisane konkretnej osobie należy tylko do niej: kandydaci liczą się, gdy osoby nie ma.
    { assignedToId: null, candidates: { some: { userId: id } } },
    { assignedToId: null, candidates: { some: { role: { code: role } } } },
    { assignedToId: null, candidates: { some: { group: { members: { some: activeGroupMembershipWhere(id, now) } } } } }
  ];
}

/**
 * Warunek Prisma: zadanie, na którym użytkownik może działać — samodzielnie albo w zastępstwie.
 *
 * Zastępca przejmuje tylko to, co zastępowany sam może zrobić, więc nigdy decyzji
 * o dokumencie zastępowanego. Inaczej autor mógłby wskazać zastępcę, który zatwierdzi
 * jego własny dokument z roli, do której autor należy.
 */
export function taskAssignedToUserWhere(user: AccessUser, now: Date = new Date()): Prisma.WorkflowTaskWhereInput {
  const substituted: Prisma.WorkflowTaskWhereInput[] = (user.actingFor ?? []).map((principal) => ({
    document: { authorId: { not: principal.id } },
    OR: identityTaskConditions(principal.id, principal.role, now)
  }));
  return { OR: [...substituted, ...identityTaskConditions(user.id, user.role, now)] };
}

export const CommentVisibility = {
  /** Widoczny wyłącznie dla osób prowadzących obieg — nie dla autora dokumentu. */
  INTERNAL: "INTERNAL",
  /** Widoczny także dla autora dokumentu. */
  AUTHOR: "AUTHOR"
} as const;

/**
 * Filtr komentarzy dla autora dokumentu: widzi komentarze skierowane do niego
 * oraz własne wpisy, ale nie notatki wewnętrzne akceptujących.
 * Role z pełnym wglądem (admin, audytor) oraz pozostali uczestnicy obiegu widzą wszystko.
 */
export function commentVisibilityWhere(user: AccessUser, document: VisibilityDocument): Prisma.CommentWhereInput {
  if (!canSeeInternalComments(user, document)) return { OR: [{ visibility: CommentVisibility.AUTHOR }, { userId: user.id }] };
  return {};
}

/** Dokument po sprawdzeniu dostępu: `infoOnly`, gdy jedyną podstawą wglądu jest etap „do wiadomości”. */
type VisibilityDocument = { authorId: string; infoOnly?: boolean };

/**
 * Czy użytkownik może zobaczyć pełną historię akcji obiegu.
 * Wpisy typu COMMENT powielają treść komentarza, więc autorowi pokazujemy je
 * dopiero po odfiltrowaniu — treści notatek wewnętrznych nie wolno tędy wyciec.
 */
export function canSeeInternalComments(user: AccessUser, document: VisibilityDocument) {
  if (canSeeAllDocuments(user.role)) return true;
  // Odbiorca „do wiadomości” widzi treść i załączniki, ale nie notatki osób prowadzących obieg.
  return document.authorId !== user.id && !document.infoOnly;
}

/** Filtr wpisów historii: ta sama reguła dla każdego endpointu zwracającego akcje obiegu. */
export function workflowActionVisibilityWhere(user: AccessUser, document: VisibilityDocument): Prisma.WorkflowActionWhereInput {
  return canSeeInternalComments(user, document) ? {} : { actionType: { not: "COMMENT" } };
}

/**
 * Czy użytkownik działa jako autor. Sam fakt autorstwa nie wystarcza: po zmianie roli na tylko
 * do odczytu konto widzi swoje stare dokumenty, ale nie może ich już zmieniać ani składać.
 */
function actsAsAuthor(document: { authorId: string }, user: AccessUser) {
  return document.authorId === user.id && roleCapabilities(user.role).createDocuments;
}

const documentAccessSelect = {
  id: true,
  authorId: true,
  departmentId: true,
  status: true,
  submittedAt: true,
  typeId: true,
  type: { select: { category: true } }
} as const;

/**
 * `db`: klient transakcji, gdy kontrola i odczyt danych mają widzieć ten sam stan (wgląd „do wiadomości”
 * cofany przy zwrocie). Bez niego — zwykły klient.
 */
export async function assertDocumentPermission(
  documentId: string,
  user: Request["user"],
  permission: DocumentPermission,
  db: Prisma.TransactionClient = prisma
) {
  if (!user) throw new AppError(401, "Zaloguj się, aby kontynuować");

  const document = await db.document.findUnique({ where: { id: documentId }, select: documentAccessSelect });
  if (!document) throw new AppError(404, "Nie znaleziono dokumentu");

  if (permission === DocumentPermission.VIEW) {
    if (canSeeAllDocuments(user.role)) return { ...document, infoOnly: false };
    const now = new Date();
    const participant = await db.document.count({ where: { AND: [{ id: documentId }, participantVisibilityWhere(user, now)] } });
    if (participant) return { ...document, infoOnly: false };
    const informed = await db.document.count({ where: { AND: [{ id: documentId }, infoRecipientWhere(user)] } });
    if (!informed) throw new AppError(403, "Nie masz dostępu do tego dokumentu");
    return { ...document, infoOnly: true };
  }

  // Administrator może zdjąć z obiegu dokument, który utknął, ale nie zmienia cudzej treści.
  if (permission === DocumentPermission.CANCEL && user.role === SystemRole.SYSTEM_ADMIN
    && CANCELLABLE_DOCUMENT_STATUSES.includes(document.status)) {
    return document;
  }

  // Usuwa wyłącznie autor, także administrator nie kasuje cudzej pracy. Stan (szkic, nigdy
  // niewysłany) serwis sprawdza w transakcji, żeby odpowiedzieć 409 zamiast mylącego 403.
  if (permission === DocumentPermission.DELETE) {
    if (!actsAsAuthor(document, user)) throw new AppError(403, "Usunąć szkic może tylko jego autor");
    return document;
  }

  const hasTaskAccess = canDecideTasks(user.role)
    ? await db.workflowTask.count({ where: { documentId, ...taskAssignedToUserWhere(user) } })
    : 0;
  const allowed = isPermissionAllowedForStatus(permission, document.status, {
    isAuthor: actsAsAuthor(document, user),
    hasTaskAccess: hasTaskAccess > 0
  });
  if (!allowed) throw new AppError(403, "Ta operacja nie jest dostępna dla tego dokumentu");
  return document;
}

export function assertDocumentAccess(documentId: string, user: Request["user"], db: Prisma.TransactionClient = prisma) {
  return assertDocumentPermission(documentId, user, DocumentPermission.VIEW, db);
}

/** Co użytkownik może zrobić z dokumentem: frontend pokazuje przyciski na tej podstawie, nie zgaduje. */
export async function documentActionsFor(
  document: { id: string; authorId: string; status: string; submittedAt: Date | null; type: { category: string } },
  user: AccessUser
) {
  const isAuthor = actsAsAuthor(document, user);
  const hasTaskAccess = canDecideTasks(user.role) && (await prisma.workflowTask.count({
    where: { documentId: document.id, ...taskAssignedToUserWhere(user) }
  })) > 0;
  const context = { isAuthor, hasTaskAccess };
  return {
    canEdit: isPermissionAllowedForStatus(DocumentPermission.EDIT, document.status, context),
    canSubmit: isPermissionAllowedForStatus(DocumentPermission.SUBMIT, document.status, context),
    canUpload: isPermissionAllowedForStatus(DocumentPermission.UPLOAD, document.status, context),
    canComment: isPermissionAllowedForStatus(DocumentPermission.COMMENT, document.status, context),
    canCancel: isPermissionAllowedForStatus(DocumentPermission.CANCEL, document.status, context)
      || (user.role === SystemRole.SYSTEM_ADMIN && CANCELLABLE_DOCUMENT_STATUSES.includes(document.status)),
    canDelete: isAuthor && isDeletableDraft(document),
    canArchive: document.status === DocumentStatus.APPROVED && canArchiveCategory(user.role, document.type.category),
    canReassign: user.role === SystemRole.SYSTEM_ADMIN && document.status === DocumentStatus.IN_APPROVAL
  };
}
