import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

const MAX_ATTEMPTS = 3;

/**
 * Transakcja Serializable z ponowieniem przy zakleszczeniu.
 * MSSQL rozwiązuje konflikty, odrzucając jedną ze stron (P2034): dla użytkownika to
 * chwilowa kolizja, a nie błąd, więc ponawiamy, zanim zgłosimy mu konflikt.
 */
export async function serializableTransaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await prisma.$transaction(work, { isolationLevel: "Serializable", maxWait: 10_000, timeout: 20_000 });
    } catch (error) {
      const retryable = error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
      if (!retryable || attempt >= MAX_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}
