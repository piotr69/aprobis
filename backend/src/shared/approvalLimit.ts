import { Prisma } from "@prisma/client";

type LimitHolder = { approvalLimitAmount?: unknown; approvalLimitCurrency?: string | null };
type LimitedDocument = { amount?: unknown; currency?: string | null };

/**
 * Czy kwota dokumentu przekracza limit akceptacji osoby. Limit ustawia administrator;
 * brak limitu oznacza brak ograniczenia, a dokument bez kwoty żadnego limitu nie przekracza.
 *
 * Limit w innej walucie niż dokument liczymy jako przekroczony: system nie zna kursów,
 * więc w razie wątpliwości decyzja idzie wyżej, a nie przechodzi po cichu.
 * Kwoty porównujemy dokładnie: `Number` gubi grosze przy dużych wartościach Decimal(18,2).
 */
export function exceedsApprovalLimit(user: LimitHolder, document: LimitedDocument) {
  if (user.approvalLimitAmount === null || user.approvalLimitAmount === undefined) return false;
  if (document.amount === null || document.amount === undefined) return false;
  if ((user.approvalLimitCurrency ?? "PLN") !== (document.currency ?? "PLN")) return true;
  return new Prisma.Decimal(String(document.amount)).gt(new Prisma.Decimal(String(user.approvalLimitAmount)));
}
