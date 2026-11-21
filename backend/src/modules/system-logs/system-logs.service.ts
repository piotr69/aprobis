import fs from "node:fs";
import path from "node:path";
import { prisma } from "../../shared/prisma.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Tylko pliki pisane przez nasz logger: api-RRRR-MM-DD.log i worker-RRRR-MM-DD.log.
 * Jawna lista źródeł, żeby nie skasować cudzych dziennych logów, gdyby trafiły do tego katalogu.
 */
const LOG_FILE_PATTERN = /^(?:api|worker)-(\d{4}-\d{2}-\d{2})\.log$/;

/** Kasuje stare dzienne pliki. Nie dotyka bazy i nie rzuca: przy awarii SQL pliki są jedynym zapisem logów. */
export async function purgeOldLogFiles(directory: string, cutoff: Date) {
  let files = 0;
  const cutoffDay = cutoff.toLocaleDateString("sv-SE");
  const names = await fs.promises.readdir(directory).catch(() => [] as string[]);
  for (const name of names) {
    const match = LOG_FILE_PATTERN.exec(name);
    // Porównanie dat w formacie RRRR-MM-DD działa jak porównanie tekstów.
    if (!match || match[1] >= cutoffDay) continue;
    await fs.promises.unlink(path.join(directory, name)).then(() => { files += 1; }, () => undefined);
  }
  return files;
}

/**
 * Kasuje logi techniczne starsze niż `retentionDays`: najpierw pliki (bez bazy), potem wpisy w bazie.
 * Błąd bazy wychodzi wyjątkiem dopiero po sprzątnięciu plików. Audytu to nie dotyczy.
 */
export async function purgeOldLogs(retentionDays: number, directory: string, now = new Date()) {
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const files = await purgeOldLogFiles(directory, cutoff);
  const { count } = await prisma.systemLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return { rows: count, files };
}
