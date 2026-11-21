import { describe, expect, it } from "vitest";
import { publicUserSelect } from "../src/shared/userSelect.js";
import {
  activeGroupMembershipWhere,
  canSeeInternalComments,
  commentVisibilityWhere,
  isPermissionAllowedForStatus,
  taskAssignedToUserWhere
} from "../src/shared/access.js";
import { EDITABLE_DOCUMENT_STATUSES, isDeletableDraft, SUBMITTABLE_DOCUMENT_STATUSES } from "../src/shared/domain.js";
import { canPerformTask, isActiveMembership, isSelfApproval } from "../src/shared/taskAccess.js";
import { parseConditions, parseActions } from "../src/modules/workflow/ruleMatcher.js";
import { DocumentStatus, SystemRole } from "../src/shared/domain.js";

describe("isDeletableDraft", () => {
  it("usunąć można tylko szkic, który nigdy nie był wysłany", () => {
    expect(isDeletableDraft({ status: DocumentStatus.DRAFT, submittedAt: null })).toBe(true);
    expect(isDeletableDraft({ status: DocumentStatus.DRAFT, submittedAt: new Date() })).toBe(false);
    for (const status of [DocumentStatus.NEEDS_CORRECTION, DocumentStatus.REGISTERED, DocumentStatus.IN_APPROVAL, DocumentStatus.CANCELLED]) {
      expect(isDeletableDraft({ status, submittedAt: null })).toBe(false);
    }
  });
});

describe("publicUserSelect", () => {
  it("nie ujawnia hasła ani uprawnień", () => {
    expect(publicUserSelect).not.toHaveProperty("passwordHash");
    expect(publicUserSelect).not.toHaveProperty("permissionsJson");
    expect(publicUserSelect).not.toHaveProperty("email");
  });

  it("zawiera tylko bezpieczne pola", () => {
    expect(Object.keys(publicUserSelect).sort()).toEqual(["firstName", "id", "lastName", "role"]);
  });
});

describe("canPerformTask", () => {
  const task = { assignedToId: "user-1", assignedRole: "ACCOUNTING" };

  it("nie pozwala administratorowi omijać rozdziału obowiązków", () => {
    expect(canPerformTask(task, { userId: "other", role: SystemRole.SYSTEM_ADMIN })).toBe(false);
  });

  it("pozwala przypisanemu użytkownikowi", () => {
    expect(canPerformTask(task, { userId: "user-1", role: SystemRole.EMPLOYEE })).toBe(true);
  });

  it("nie pozwala roli przejąć zadania przypisanego konkretnej osobie", () => {
    expect(canPerformTask(task, { userId: "other", role: SystemRole.ACCOUNTING })).toBe(false);
  });

  it("pozwala roli wykonać zadanie bez przypisanej osoby", () => {
    expect(canPerformTask({ assignedToId: null, assignedRole: "ACCOUNTING" }, { userId: "other", role: SystemRole.ACCOUNTING })).toBe(true);
  });

  it("odrzuca obcego użytkownika", () => {
    expect(canPerformTask(task, { userId: "other", role: SystemRole.EMPLOYEE })).toBe(false);
  });

  it("odrzuca brak zadania", () => {
    expect(canPerformTask(null, { userId: "user-1", role: SystemRole.SYSTEM_ADMIN })).toBe(false);
  });
});

describe("isPermissionAllowedForStatus", () => {
  const author = { isAuthor: true, hasTaskAccess: false };
  const approver = { isAuthor: false, hasTaskAccess: true };
  const stranger = { isAuthor: false, hasTaskAccess: false };

  it("pozwala autorowi uruchomić obieg na dokumencie zarejestrowanym", () => {
    // Warstwa uprawnień dopuszczała tylko DRAFT i NEEDS_CORRECTION, a silnik przyjmował
    // też REGISTERED — przycisk „Uruchom workflow" kończył się 403.
    expect(isPermissionAllowedForStatus("SUBMIT", DocumentStatus.REGISTERED, author)).toBe(true);
    expect(SUBMITTABLE_DOCUMENT_STATUSES).toContain(DocumentStatus.REGISTERED);
  });

  it("nie pozwala edytować dokumentu zarejestrowanego", () => {
    // Treść po rejestracji jest zamknięta — SUBMIT ma szerszy zbiór niż EDIT.
    expect(isPermissionAllowedForStatus("EDIT", DocumentStatus.REGISTERED, author)).toBe(false);
    expect(isPermissionAllowedForStatus("UPLOAD", DocumentStatus.REGISTERED, author)).toBe(false);
    expect(EDITABLE_DOCUMENT_STATUSES).not.toContain(DocumentStatus.REGISTERED);
  });

  it("pozwala autorowi edytować szkic i dokument do poprawy", () => {
    expect(isPermissionAllowedForStatus("EDIT", DocumentStatus.DRAFT, author)).toBe(true);
    expect(isPermissionAllowedForStatus("EDIT", DocumentStatus.NEEDS_CORRECTION, author)).toBe(true);
  });

  it("nie pozwala wysłać dokumentu będącego już w akceptacji", () => {
    expect(isPermissionAllowedForStatus("SUBMIT", DocumentStatus.IN_APPROVAL, author)).toBe(false);
  });

  it("wiąże edycję i wysyłkę z autorstwem, nie z udziałem w obiegu", () => {
    expect(isPermissionAllowedForStatus("SUBMIT", DocumentStatus.DRAFT, approver)).toBe(false);
    expect(isPermissionAllowedForStatus("EDIT", DocumentStatus.DRAFT, approver)).toBe(false);
  });

  it("daje podgląd autorowi i uczestnikowi obiegu, ale nie obcemu", () => {
    expect(isPermissionAllowedForStatus("VIEW", DocumentStatus.IN_APPROVAL, author)).toBe(true);
    expect(isPermissionAllowedForStatus("VIEW", DocumentStatus.IN_APPROVAL, approver)).toBe(true);
    expect(isPermissionAllowedForStatus("VIEW", DocumentStatus.IN_APPROVAL, stranger)).toBe(false);
  });

  it("blokuje komentowanie dokumentu zarchiwizowanego", () => {
    expect(isPermissionAllowedForStatus("COMMENT", DocumentStatus.ARCHIVED, approver)).toBe(false);
    expect(isPermissionAllowedForStatus("COMMENT", DocumentStatus.IN_APPROVAL, approver)).toBe(true);
  });

  it("pozwala autorowi wycofać dokument przed końcem akceptacji", () => {
    expect(isPermissionAllowedForStatus("CANCEL", DocumentStatus.REGISTERED, author)).toBe(true);
    expect(isPermissionAllowedForStatus("CANCEL", DocumentStatus.IN_APPROVAL, author)).toBe(true);
    expect(isPermissionAllowedForStatus("CANCEL", DocumentStatus.APPROVED, author)).toBe(false);
  });
});

describe("activeGroupMembershipWhere", () => {
  const now = new Date("2026-06-15T12:00:00Z");

  it("wymaga obu granic ważności członkostwa", () => {
    // Sam userId przepuszczałby członków zapisanych „na przyszłość".
    expect(activeGroupMembershipWhere("user-1", now)).toEqual({
      userId: "user-1",
      validFrom: { lte: now },
      OR: [{ validTo: null }, { validTo: { gte: now } }]
    });
  });

  it("każda ścieżka kandydata z grupy przechodzi przez ten sam filtr", () => {
    const where = taskAssignedToUserWhere({ id: "user-1", role: SystemRole.ACCOUNTING } as never, now);
    const groupBranch = where.OR!.at(-1) as { candidates: { some: { group: { members: { some: unknown } } } } };
    expect(groupBranch.candidates.some.group.members.some).toEqual(activeGroupMembershipWhere("user-1", now));
  });
});

describe("widoczność komentarzy", () => {
  const document = { authorId: "author-1" };
  const author = { id: "author-1", role: SystemRole.EMPLOYEE } as never;
  const approver = { id: "approver-1", role: SystemRole.DEPARTMENT_MANAGER } as never;
  const auditor = { id: "auditor-1", role: SystemRole.AUDITOR } as never;

  it("ukrywa przed autorem notatki wewnętrzne, zostawiając jego własne i skierowane do niego", () => {
    expect(commentVisibilityWhere(author, document)).toEqual({
      OR: [{ visibility: "AUTHOR" }, { userId: "author-1" }]
    });
    expect(canSeeInternalComments(author, document)).toBe(false);
  });

  it("nie ogranicza pozostałych uczestników obiegu", () => {
    expect(commentVisibilityWhere(approver, document)).toEqual({});
    expect(canSeeInternalComments(approver, document)).toBe(true);
  });

  it("nie ogranicza audytora, nawet gdy jest autorem", () => {
    expect(commentVisibilityWhere(auditor, { authorId: "auditor-1" })).toEqual({});
    expect(canSeeInternalComments(auditor, { authorId: "auditor-1" })).toBe(true);
  });
});

describe("isSelfApproval", () => {
  const authorTask = { document: { authorId: "author-1" } };

  it("blokuje autora, gdy etap nie zezwala na samoakceptację", () => {
    expect(isSelfApproval(authorTask, "author-1")).toBe(true);
  });

  it("nie blokuje osoby innej niż autor", () => {
    expect(isSelfApproval(authorTask, "approver-1")).toBe(false);
  });

  it("blokuje autora, który trafił na zadanie jako kandydat z roli lub grupy", () => {
    // Kandydat z roli nie ma assignedToId — bez tej reguły autor mógłby zaakceptować własny dokument.
    const candidateTask = { ...authorTask, instanceStage: { configSnapshotJson: JSON.stringify({}) } };
    expect(isSelfApproval(candidateTask, "author-1")).toBe(true);
  });

  it("przepuszcza autora na etapie korekty (snapshot zezwala)", () => {
    const correction = { ...authorTask, instanceStage: { configSnapshotJson: JSON.stringify({ allowSelfApproval: true }) } };
    expect(isSelfApproval(correction, "author-1")).toBe(false);
  });

  it("snapshot etapu ma pierwszeństwo przed definicją kroku", () => {
    const task = {
      ...authorTask,
      instanceStage: { configSnapshotJson: JSON.stringify({ allowSelfApproval: false }) },
      step: { allowSelfApproval: true }
    };
    expect(isSelfApproval(task, "author-1")).toBe(true);
  });

  it("używa definicji kroku, gdy brak snapshotu", () => {
    expect(isSelfApproval({ ...authorTask, step: { allowSelfApproval: true } }, "author-1")).toBe(false);
  });

  it("uszkodzony snapshot traktuje jak brak zgody", () => {
    const task = { ...authorTask, instanceStage: { configSnapshotJson: "{ zepsute" }, step: { allowSelfApproval: true } };
    expect(isSelfApproval(task, "author-1")).toBe(true);
  });
});

describe("isActiveMembership", () => {
  const now = new Date("2026-06-15T12:00:00Z");

  it("odrzuca członkostwo, które jeszcze się nie zaczęło", () => {
    expect(isActiveMembership({ validFrom: new Date("2026-07-01"), validTo: null }, now)).toBe(false);
  });

  it("odrzuca członkostwo wygasłe", () => {
    expect(isActiveMembership({ validFrom: new Date("2026-01-01"), validTo: new Date("2026-05-01") }, now)).toBe(false);
  });

  it("akceptuje członkostwo bezterminowe w trakcie obowiązywania", () => {
    expect(isActiveMembership({ validFrom: new Date("2026-01-01"), validTo: null }, now)).toBe(true);
  });

  it("akceptuje członkostwo w oknie ważności", () => {
    expect(isActiveMembership({ validFrom: new Date("2026-01-01"), validTo: new Date("2026-12-31") }, now)).toBe(true);
  });
});

describe("odporność parsera reguł", () => {
  it("uszkodzona konfiguracja daje jawny stan null, a nie warunek pasujący do wszystkiego", () => {
    expect(parseConditions("{ to nie jest json")).toBeNull();
    expect(parseConditions("null")).toBeNull();
    expect(parseConditions('{"amountMin":"dużo"}')).toBeNull();
    expect(parseActions("###")).toBeNull();
    expect(parseActions('{"steps":{}}')).toBeNull();
  });

  it("parsuje poprawny JSON", () => {
    expect(parseConditions('{"amountMax":5000}')).toEqual({ amountMax: 5000 });
    expect(parseActions('{"stopProcessing":true}')).toEqual({ stopProcessing: true });
  });
});

describe("walidacja statusu dokumentu", () => {
  const validStatuses = Object.values(DocumentStatus) as string[];

  it("uznaje znane statusy", () => {
    expect(validStatuses.includes("APPROVED")).toBe(true);
  });

  it("odrzuca status spoza enuma (ochrona przed obejściem workflow)", () => {
    expect(validStatuses.includes("APPROVED_BY_HACK")).toBe(false);
  });
});
