import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { databaseSettings, databaseUrl, secret, sqlPassword } from "./settings.mjs";

let step = "validate configuration";

function run(args, url) {
  const result = spawnSync(process.execPath, args, {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url }
  });
  if (result.error || result.status !== 0) throw new Error("Initialization command failed");
}

async function withDatabase(url, work) {
  const client = new PrismaClient({ datasources: { db: { url } }, log: [] });
  try { return await work(client); }
  finally { await client.$disconnect(); }
}

async function main() {
  const settings = databaseSettings();
  // This installer owns only its dedicated container database, never system databases/logins.
  if (["master", "model", "msdb", "tempdb"].includes(settings.database.toLowerCase()) || settings.login.toLowerCase() === "sa") {
    throw new Error("System database/login is not allowed");
  }
  const sa = sqlPassword(secret(process.env.SQL_SA_PASSWORD_FILE, "SQL administrator password"));
  const app = sqlPassword(secret(process.env.SQL_APP_PASSWORD_FILE, "SQL app password"));
  if (sa === app) throw new Error("Use independent SQL passwords");
  const adminUrl = databaseUrl(settings, "sa", sa);
  const appUrl = databaseUrl(settings, settings.login, app);

  step = "create database and application login";
  await withDatabase(databaseUrl(settings, "sa", sa, "master"), async (db) => {
    const exists = await db.$queryRaw`SELECT name FROM sys.databases WHERE name = ${settings.database}`;
    if (!exists.length) {
      // Identifiers and passwords were strictly validated above; these DDL statements cannot bind identifiers.
      await db.$executeRawUnsafe(`CREATE DATABASE [${settings.database}] COLLATE Polish_100_CI_AS`);
    }
    const logins = await db.$queryRaw`SELECT name FROM sys.sql_logins WHERE name = ${settings.login}`;
    if (!logins.length) {
      await db.$executeRawUnsafe(`CREATE LOGIN [${settings.login}] WITH PASSWORD = '${app}', CHECK_POLICY = ON, CHECK_EXPIRATION = OFF`);
    }
    // Existing login: do not reset it or take it over. The password must still match the supplied secret.
  });

  step = "apply migrations";
  run(["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", "prisma/schema.prisma"], adminUrl);

  step = "grant database access";
  await withDatabase(adminUrl, async (db) => {
    const users = await db.$queryRaw`SELECT name FROM sys.database_principals WHERE name = ${settings.login}`;
    if (!users.length) await db.$executeRawUnsafe(`CREATE USER [${settings.login}] FOR LOGIN [${settings.login}]`);
    for (const role of ["db_datareader", "db_datawriter"]) {
      const member = await db.$queryRaw`SELECT IS_ROLEMEMBER(${role}, ${settings.login}) AS value`;
      if (member[0]?.value !== 1) await db.$executeRawUnsafe(`ALTER ROLE [${role}] ADD MEMBER [${settings.login}]`);
    }
  });

  step = "verify application credentials and permissions";
  await withDatabase(appUrl, async (db) => {
    const permissions = await db.$queryRaw`SELECT IS_SRVROLEMEMBER('sysadmin') AS sysadmin, IS_ROLEMEMBER('db_owner') AS owner,
      HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE TABLE') AS ddl`;
    if (permissions[0]?.sysadmin !== 0 || permissions[0]?.owner !== 0 || permissions[0]?.ddl !== 0) {
      throw new Error("Application login has excessive permissions");
    }
  });

  step = "bootstrap reference data";
  run(["node_modules/tsx/dist/cli.mjs", "prisma/bootstrap.ts"], appUrl);
  step = "create first administrator";
  run(["node_modules/tsx/dist/cli.mjs", "prisma/create-admin.ts"], appUrl);
  console.log("Aprobis initialized. No demo data was created; existing accounts and passwords were preserved.");
}

main().catch(() => {
  // Prisma errors can include a failed CREATE LOGIN statement; never print the raw error.
  console.error(`Aprobis initialization failed at: ${step}. Check configuration and database state; secrets were not printed.`);
  process.exitCode = 1;
});
