import type { SystemRole } from "./domain.js";

/**
 * Czy użytkownik może wykonać zadanie workflow.
 * Czysta funkcja (bez Prisma) — łatwa do testowania jednostkowego.
 */
export function canPerformTask(
  task: { assignedToId: string | null; assignedRole: string | null } | null,
  user: { userId: string; role?: SystemRole }
) {
  if (!task) {
    return false;
  }

  if (task.assignedToId === user.userId) {
    return true;
  }

  return Boolean(!task.assignedToId && task.assignedRole && task.assignedRole === user.role);
}

type SelfApprovalTask = {
  document: { authorId: string };
  instanceStage?: { configSnapshotJson: string | null } | null;
  step?: { allowSelfApproval: boolean } | null;
};

/**
 * Czy na tym etapie wolno działać autorowi dokumentu.
 * Snapshot etapu jest źródłem prawdy (definicja kroku mogła się zmienić po starcie obiegu),
 * `step` służy tylko jako fallback dla obiegów sprzed wprowadzenia snapshotów.
 */
export function stageAllowsSelfApproval(task: SelfApprovalTask) {
  if (task.instanceStage?.configSnapshotJson) {
    try {
      const snapshot = JSON.parse(task.instanceStage.configSnapshotJson) as { allowSelfApproval?: unknown };
      if (typeof snapshot.allowSelfApproval === "boolean") {
        return snapshot.allowSelfApproval;
      }
    } catch {
      // Uszkodzonego snapshotu nie da się zinterpretować — nie zgadujemy z definicji kroku,
      // bo ta mogła się zmienić po starcie obiegu. Fail closed.
      return false;
    }
  }
  return task.step?.allowSelfApproval ?? false;
}

/**
 * Rozdział obowiązków: autor nie decyduje o własnym dokumencie, niezależnie od tego,
 * czy trafił na zadanie jako przypisany, kandydat z roli, kandydat z grupy czy przez delegację.
 */
export function isSelfApproval(task: SelfApprovalTask, userId: string) {
  return task.document.authorId === userId && !stageAllowsSelfApproval(task);
}

/**
 * Czy członkostwo w grupie obowiązuje w danym momencie — obie granice ważności.
 */
export function isActiveMembership(
  member: { validFrom: Date; validTo: Date | null },
  now: Date = new Date()
) {
  return member.validFrom <= now && (!member.validTo || member.validTo >= now);
}
