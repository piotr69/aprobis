import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { databaseSettings, databaseUrl, identifier, secret, sqlPassword } from "../../deployment/docker/settings.mjs";

describe("konfiguracja izolowanej instalacji Docker", () => {
  const password = "Aa0_" + "x".repeat(44);

  it("odrzuca wstrzyknięcia do identyfikatorów SQL i adresu połączenia", () => {
    for (const value of ["Aprobis]; DROP DATABASE master;--", "a;b", "a'", "a b", "", "a".repeat(64)]) {
      expect(() => identifier(value, "test")).toThrow();
    }
    for (const host of ["db;database=master", "db/user", "db:1433;encrypt=false"]) {
      expect(() => databaseSettings({ SQL_HOST: host })).toThrow();
    }
    for (const port of ["0", "65536", "1433;user=sa"]) {
      expect(() => databaseSettings({ SQL_PORT: port })).toThrow();
    }
  });

  it("nie pozwala dopisać parametrów połączenia ani SQL hasłem", () => {
    for (const value of ["short", "a".repeat(40), `${password};database=master`, `${password}'`, `${password}\n`, "{secret}"]) {
      expect(() => sqlPassword(value)).toThrow();
    }
    expect(databaseUrl(databaseSettings({}), "aprobis_app", password)).toBe(
      `sqlserver://db:1433;database=Aprobis;user=aprobis_app;password=${password};encrypt=true;trustServerCertificate=true`
    );
  });

  it("czyta plik sekretu z BOM i CRLF bez zmiany treści hasła", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "aprobis-secret-test-"));
    try {
      const file = path.join(directory, "password");
      writeFileSync(file, `\uFEFF${password}\r\n`);
      expect(secret(file, "test")).toBe(password);
      expect(() => secret(undefined, "test")).toThrow();
    } finally { rmSync(directory, { recursive: true }); }
  });

  it("generator tworzy niezależne sekrety i nigdy nie nadpisuje ich przy ponowieniu", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "aprobis-generator-test-"));
    try {
      mkdirSync(path.join(directory, "scripts"));
      const script = path.join(directory, "scripts", "create-docker-secrets.mjs");
      copyFileSync(fileURLToPath(new URL("../../scripts/create-docker-secrets.mjs", import.meta.url)), script);
      const firstOutput = execFileSync(process.execPath, [script], { encoding: "utf8" });
      const names = ["sql-sa-password", "sql-app-password", "admin-password"];
      const first = names.map((name) => readFileSync(path.join(directory, ".secrets", name), "utf8"));
      expect(new Set(first).size).toBe(3);
      first.forEach((value) => {
        expect(sqlPassword(value.trim())).toBe(value.trim());
        expect(firstOutput).not.toContain(value.trim());
      });
      const secondOutput = execFileSync(process.execPath, [script], { encoding: "utf8" });
      expect(names.map((name) => readFileSync(path.join(directory, ".secrets", name), "utf8"))).toEqual(first);
      expect(secondOutput).toContain("kept existing secret");
    } finally { rmSync(directory, { recursive: true }); }
  });
});
