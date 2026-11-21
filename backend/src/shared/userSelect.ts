import type { Prisma } from "@prisma/client";

/**
 * Bezpieczny zestaw pól użytkownika udostępniany klientowi.
 * Celowo pomija passwordHash i dane kontaktowe — e-maile widzą tylko role katalogowe
 * przez `/users`. Nigdy nie zwracaj pełnego obiektu User przez `include: { ...: true }`.
 */
export const publicUserSelect = {
  id: true,
  firstName: true,
  lastName: true,
  role: true
} as const satisfies Prisma.UserSelect;
