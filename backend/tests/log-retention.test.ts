import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Baza niedostępna: każde zapytanie kończy się błędem.
vi.mock("../src/shared/prisma.js", () => ({
  prisma: { systemLog: { deleteMany: async () => { throw new Error("SQL niedostępny"); } } }
}));

const { purgeOldLogs } = await import("../src/modules/system-logs/system-logs.service.js");

describe("retencja plików logów", () => {
  let directory: string;
  const now = new Date("2026-11-06T12:00:00");

  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "log-retention-")); });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  it("sprząta stare pliki także przy awarii bazy, a błąd bazy zgłasza dalej", async () => {
    for (const name of ["api-2020-01-01.log", "worker-2020-01-01.log", "api-2026-11-01.log"]) {
      fs.writeFileSync(path.join(directory, name), "x\n");
    }

    await expect(purgeOldLogs(90, directory, now)).rejects.toThrow("SQL niedostępny");

    expect(fs.readdirSync(directory)).toEqual(["api-2026-11-01.log"]);
  });

  it("nie usuwa cudzych dziennych logów, nawet ze starą datą", async () => {
    for (const name of ["other-app-2020-01-01.log", "backup-2020-01-01.log", "notatka.txt"]) {
      fs.writeFileSync(path.join(directory, name), "x\n");
    }

    await expect(purgeOldLogs(90, directory, now)).rejects.toThrow();

    expect(fs.readdirSync(directory).sort()).toEqual(["backup-2020-01-01.log", "notatka.txt", "other-app-2020-01-01.log"]);
  });
});
