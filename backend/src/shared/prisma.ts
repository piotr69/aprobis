import { PrismaClient } from "@prisma/client";

// Logowanie zapytań na żądanie (PRISMA_LOG_QUERIES=1): worker odpytuje bazę co 2 s i zalewał logi.
export const prisma = new PrismaClient({
  log: process.env.PRISMA_LOG_QUERIES === "1" ? ["query", "warn", "error"] : ["warn", "error"]
});
