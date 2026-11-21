import { execSync } from "node:child_process";
import { repoRoot, testDatabaseUrl } from "./test-database.js";

/** Przed całym przebiegiem: migracje i świeży seed wyłącznie w bazie testowej (osłona w testDatabaseUrl). */
export default function setup() {
  const url = testDatabaseUrl();
  const env = { ...process.env, DATABASE_URL: url, NODE_ENV: "test", SEED_CONFIRM: "delete-all" };
  execSync("npx prisma migrate deploy --schema prisma/schema.prisma", { cwd: repoRoot, env, stdio: "pipe" });
  execSync("npx tsx prisma/seed.ts", { cwd: repoRoot, env, stdio: "pipe" });
}
