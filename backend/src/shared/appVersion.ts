import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "../config/env.js";
import { logger } from "./logger.js";
import { prisma } from "./prisma.js";

/**
 * Wersja programu. Numer jest w kluczu systemowym APP_VERSION, który API przy starcie
 * ustawia z package.json. Zapis następuje tylko przy innym numerze, więc `updatedAt` klucza to chwila
 * zmiany wersji: ponowna instalacja tej samej wersji nie odnawia dopisku „Nowa wersja”.
 * Commit i datę instalacji zapisuje instalator w release.json; to tylko informacja w podpowiedzi.
 */
export const APP_VERSION_KEY = "APP_VERSION";
export const NEW_VERSION_DAYS = 2;

/** Ile jeszcze pokazywać „Nowa wersja”. Data z przyszłości (przestawiony zegar) też liczy się jako nowa. */
export function newVersionRemainingMs(changedAt: Date | null, now: Date) {
  if (!changedAt) return 0;
  return Math.max(0, changedAt.getTime() + NEW_VERSION_DAYS * 24 * 60 * 60 * 1000 - now.getTime());
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    // PowerShell 5.1 zapisuje UTF-8 ze znacznikiem BOM, którego JSON.parse nie przyjmuje.
    const value: unknown = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function packageVersion(root = repoRoot): string | null {
  const version = readJson(path.join(root, "package.json"))?.version;
  return typeof version === "string" && version.trim() ? version.trim() : null;
}

export function readRelease(root = repoRoot): { commit: string | null; installedAt: Date | null } {
  const release = readJson(path.join(root, "release.json"));
  const commit = typeof release?.commit === "string" && /^[0-9a-f]{7,40}$/i.test(release.commit) ? release.commit.slice(0, 7) : null;
  const installed = typeof release?.zainstalowano === "string" ? new Date(release.zainstalowano) : null;
  return { commit, installedAt: installed && !Number.isNaN(installed.getTime()) ? installed : null };
}

/** Wywoływane przy starcie API. Błąd nie zatrzymuje API: wersja to tylko informacja. */
export async function syncAppVersion() {
  const version = packageVersion();
  if (!version) return;
  try {
    const row = await prisma.appConfig.findUnique({ where: { key: APP_VERSION_KEY }, select: { value: true } });
    if (!row) {
      await prisma.appConfig.create({
        data: { key: APP_VERSION_KEY, value: version, type: "string", category: "System", isSystem: true, description: "Numer wersji pokazywany w menu." }
      });
    } else if (row.value !== version) {
      await prisma.appConfig.update({ where: { key: APP_VERSION_KEY }, data: { value: version, updatedById: null } });
    } else {
      return;
    }
    logger.info("Nowa wersja programu", { version, previous: row?.value ?? null });
  } catch (error) {
    logger.error("Nie udało się zapisać wersji programu", { error: error instanceof Error ? error.message : String(error) });
  }
}

export async function versionInfo(now = new Date()) {
  const row = await prisma.appConfig.findUnique({ where: { key: APP_VERSION_KEY }, select: { value: true, updatedAt: true } });
  const release = readRelease();
  const changedAt = row?.value ? row.updatedAt : null;
  const remaining = newVersionRemainingMs(changedAt, now);
  return {
    version: row?.value ?? null,
    commit: release.commit,
    installedAt: release.installedAt?.toISOString() ?? null,
    changedAt: changedAt?.toISOString() ?? null,
    isNew: remaining > 0,
    newRemainingMs: remaining
  };
}
