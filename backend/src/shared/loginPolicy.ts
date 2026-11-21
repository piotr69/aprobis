import { createHash, randomBytes } from "node:crypto";

/**
 * Zasady logowania i odzyskiwania hasła: blokada po kolejnych błędach, limity prób z jednego adresu
 * i jednorazowy link resetu z krótkim terminem ważności.
 */
export const MAX_LOGIN_ATTEMPTS = 3;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
export const LOGIN_RATE_LIMIT = { windowMs: 15 * 60 * 1000, max: 10 };
export const RESET_RATE_LIMIT = { windowMs: 15 * 60 * 1000, max: 5 };
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Czy konto jest w czasowej blokadzie. Blokada wygasa sama: to nie dezaktywacja przez administratora. */
export function isWithinLockout(
  user: { failedLoginAttempts: number; lockedAt: Date | null },
  now: Date = new Date()
) {
  if (!user.lockedAt || user.failedLoginAttempts < MAX_LOGIN_ATTEMPTS) return false;
  return now.getTime() - user.lockedAt.getTime() < LOCKOUT_DURATION_MS;
}

export function hashResetToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** Do maila trafia token, a do bazy tylko jego skrót: wyciek bazy nie daje aktywnych linków. */
export function generateResetToken() {
  const token = randomBytes(32).toString("hex");
  return { token, tokenHash: hashResetToken(token), expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) };
}
