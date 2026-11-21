import type { Request } from "express";
import { identityTaskConditions } from "../../shared/access.js";
import { exceedsApprovalLimit } from "../../shared/approvalLimit.js";
import { prisma } from "../../shared/prisma.js";

type AccessUser = NonNullable<Request["user"]>;
type LimitedTask = { id: string; document: { amount?: unknown; currency?: string | null } };

/**
 * Czy akceptacja zadania przekroczyłaby limit — dla tej samej tożsamości, którą wybierze silnik
 * (`resolveActor`): najpierw użytkownik we własnym imieniu, a gdy sam nie może działać, pierwszy
 * zastępowany, który może. W zastępstwie liczą się oba limity, jak przy decyzji; we własnym
 * imieniu nieużywane zastępstwo niczego nie ogranicza.
 *
 * Lista zadań i szczegóły dokumentu muszą zwracać to samo, co potem sprawdzi decyzja,
 * inaczej ekran pokaże „Zatwierdź”, którego backend odmówi.
 */
export async function approvalLimitFlags(user: AccessUser, tasks: LimitedTask[], now: Date = new Date()) {
  const flags = new Map<string, boolean>();
  if (tasks.length === 0) return flags;
  const ids = tasks.map((task) => task.id);

  const own = await prisma.workflowTask.findMany({
    where: { id: { in: ids }, OR: identityTaskConditions(user.id, user.role, now) },
    select: { id: true }
  });
  const ownIds = new Set(own.map((task) => task.id));

  // Zastępowany dla zadań, których użytkownik nie może wykonać sam: kolejność jak w resolveActor.
  const principalOf = new Map<string, string>();
  let remaining = ids.filter((id) => !ownIds.has(id));
  for (const principal of user.actingFor ?? []) {
    if (remaining.length === 0) break;
    const matched = await prisma.workflowTask.findMany({
      where: {
        id: { in: remaining },
        document: { authorId: { not: principal.id } },
        OR: identityTaskConditions(principal.id, principal.role, now)
      },
      select: { id: true }
    });
    for (const task of matched) principalOf.set(task.id, principal.id);
    remaining = remaining.filter((id) => !principalOf.has(id));
  }

  const people = await prisma.user.findMany({
    where: { id: { in: [user.id, ...new Set(principalOf.values())] } },
    select: { id: true, approvalLimitAmount: true, approvalLimitCurrency: true }
  });
  const limitOf = new Map(people.map((person) => [person.id, person]));

  for (const task of tasks) {
    const deciders = [user.id, ...(principalOf.has(task.id) ? [principalOf.get(task.id)!] : [])];
    flags.set(task.id, deciders.some((id) => {
      const person = limitOf.get(id);
      return person ? exceedsApprovalLimit(person, task.document) : true;
    }));
  }
  return flags;
}
