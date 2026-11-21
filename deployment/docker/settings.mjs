import { readFileSync } from "node:fs";

export function identifier(value, label) {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(value ?? "")) {
    throw new Error(`${label}: expected 1-63 ASCII letters, digits or underscores, starting with a letter`);
  }
  return value;
}

export function secret(file, label) {
  if (!file) throw new Error(`Missing ${label} file`);
  return readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r?\n$/, "");
}

// A deliberately restricted alphabet avoids ambiguous JDBC-style URL escaping.
// scripts/create-docker-secrets.mjs generates compatible, independent random passwords.
export function sqlPassword(value) {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(value) || !/[A-Z]/.test(value) || !/[a-z]/.test(value) || !/[0-9]/.test(value)) {
    throw new Error("SQL secret: use 32-128 ASCII letters, digits, underscores or hyphens, including upper/lower case and a digit");
  }
  return value;
}

export function databaseSettings(env = process.env) {
  const host = env.SQL_HOST ?? "db";
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)) throw new Error("Invalid SQL_HOST");
  const port = env.SQL_PORT ?? "1433";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Invalid SQL_PORT");
  return {
    host, port,
    database: identifier(env.SQL_DATABASE ?? "Aprobis", "SQL_DATABASE"),
    login: identifier(env.SQL_APP_LOGIN ?? "aprobis_app", "SQL_APP_LOGIN")
  };
}

export function databaseUrl(settings, user, password, database = settings.database) {
  identifier(user, "SQL login");
  identifier(database, "SQL database");
  sqlPassword(password);
  return `sqlserver://${settings.host}:${settings.port};database=${database};user=${user};password=${password};encrypt=true;trustServerCertificate=true`;
}
