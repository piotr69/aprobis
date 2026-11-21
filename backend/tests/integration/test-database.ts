import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../../..");
export const TEST_DATABASE = "AprobisTest";

/**
 * Nazwa bazy z adresu SQL Server (`sqlserver://host:port;database=X;...`).
 * Zwraca null, gdy bazy nie wskazano albo wskazano ją więcej niż raz (niejednoznaczny adres).
 */
export function databaseNameOf(url: string): string | null {
  if (!/^sqlserver:\/\//i.test(url)) return null;
  const names = url
    .split(";")
    .slice(1)
    .map((part) => part.split("="))
    .filter(([key]) => /^\s*(database|initial catalog)\s*$/i.test(key ?? ""))
    .map(([, ...value]) => value.join("=").trim());
  return names.length === 1 && names[0] ? names[0] : null;
}

/** Odmawia każdej bazy poza dokładnie `AprobisTest`. Testy integracyjne kasują jej zawartość seedem. */
export function assertTestDatabaseUrl(url: string | undefined): string {
  if (!url) throw new Error("Odmowa: ustaw TEST_DATABASE_URL (w .env albo w zmiennych środowiska)");
  const name = databaseNameOf(url);
  if (name !== TEST_DATABASE) throw new Error(`Odmowa: TEST_DATABASE_URL musi wskazywać dokładnie jedną bazę ${TEST_DATABASE}`);
  return url;
}

/** Adres bazy testowej: zmienna środowiska albo wpis TEST_DATABASE_URL w `.env`. Nigdy DATABASE_URL. */
export function testDatabaseUrl(): string {
  let url = process.env.TEST_DATABASE_URL;
  const envFile = path.join(repoRoot, ".env");
  if (!url && fs.existsSync(envFile)) url = dotenv.parse(fs.readFileSync(envFile)).TEST_DATABASE_URL;
  return assertTestDatabaseUrl(url);
}
