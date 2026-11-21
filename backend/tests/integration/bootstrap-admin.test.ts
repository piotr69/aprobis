import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminBootstrapError, bootstrapAdmin } from "../../src/shared/bootstrapAdmin.js";
import { verifyPassword } from "../../src/shared/password.js";
import { prisma } from "./helpers.js";
import { repoRoot, testDatabaseUrl } from "./test-database.js";

/**
 * Pierwszy administrator na czystej bazie. Osobna, tymczasowa baza obok AprobisTest:
 * scenariusz wymaga pustej tabeli kont, a AprobisTest ma dane z seeda.
 */
const FRESH_DATABASE = "AprobisTestBootstrap";
const freshUrl = testDatabaseUrl().replace(/(database|initial catalog)=AprobisTest(?=;|$)/i, `$1=${FRESH_DATABASE}`);

const admin = { email: "admin@example.test", login: "admin", password: "PierwszeHaslo1", firstName: "Ada", lastName: "Admin" };

describe("pierwszy administrator", () => {
  let fresh: PrismaClient;

  beforeAll(async () => {
    expect(freshUrl).toMatch(new RegExp(`(database|initial catalog)=${FRESH_DATABASE}(;|$)`, "i"));
    await prisma.$executeRawUnsafe(`IF DB_ID(N'${FRESH_DATABASE}') IS NOT NULL BEGIN ALTER DATABASE [${FRESH_DATABASE}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${FRESH_DATABASE}]; END`);
    await prisma.$executeRawUnsafe(`CREATE DATABASE [${FRESH_DATABASE}]`);
    const env = { ...process.env, DATABASE_URL: freshUrl, NODE_ENV: "test" };
    execSync("npx prisma migrate deploy --schema prisma/schema.prisma", { cwd: repoRoot, env, stdio: "pipe" });
    execSync("npx tsx prisma/bootstrap.ts", { cwd: repoRoot, env, stdio: "pipe" });
    fresh = new PrismaClient({ datasourceUrl: freshUrl });
  });

  afterAll(async () => {
    await fresh?.$disconnect();
    await prisma.$executeRawUnsafe(`IF DB_ID(N'${FRESH_DATABASE}') IS NOT NULL BEGIN ALTER DATABASE [${FRESH_DATABASE}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${FRESH_DATABASE}]; END`);
  });

  it("odrzuca słabe hasło i błędny e-mail, zanim cokolwiek zapisze", async () => {
    await expect(bootstrapAdmin(fresh, { ...admin, password: "krotkie" })).rejects.toThrow();
    await expect(bootstrapAdmin(fresh, { ...admin, email: "nie-email" })).rejects.toThrow();
    expect(await fresh.user.count()).toBe(0);
  });

  it("dwa równoległe uruchomienia tworzą dokładnie jedno konto", async () => {
    const results = await Promise.all([bootstrapAdmin(fresh, admin), bootstrapAdmin(fresh, { ...admin, email: "drugi@example.test", login: "drugi" })]);
    expect(results.map((item) => item.result).sort()).toEqual(["ALREADY_INITIALIZED", "CREATED"]);
    const users = await fresh.user.findMany({ include: { roleAssignments: { include: { role: true } } } });
    expect(users).toHaveLength(1);
    expect(users[0].role).toBe("SYSTEM_ADMIN");
    expect(users[0].roleAssignments.map((item) => item.role.code)).toEqual(["SYSTEM_ADMIN"]);
    expect(await fresh.auditLog.count({ where: { action: "BOOTSTRAP_ADMIN", entityId: users[0].id } })).toBe(1);
  });

  it("ponowne uruchomienie nie zmienia hasła ani danych", async () => {
    const before = await fresh.user.findFirstOrThrow({ where: { role: "SYSTEM_ADMIN" } });
    expect(await bootstrapAdmin(fresh, { ...admin, password: "InneHaslo123" })).toEqual({ result: "ALREADY_INITIALIZED" });
    const after = await fresh.user.findFirstOrThrow({ where: { id: before.id } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(await verifyPassword(after.passwordHash, admin.password)).toBe(true);
    expect(await fresh.user.count()).toBe(1);
  });

  it("konta bez aktywnego administratora: przerywa zamiast tworzyć nowego", async () => {
    await fresh.user.updateMany({ data: { isActive: false } });
    try {
      await expect(bootstrapAdmin(fresh, { ...admin, email: "nowy@example.test", login: "nowy" })).rejects.toBeInstanceOf(AdminBootstrapError);
      expect(await fresh.user.count()).toBe(1);
    } finally {
      await fresh.user.updateMany({ data: { isActive: true } });
    }
  });
});
