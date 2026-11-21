import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { env, logRoot } from "./config/env.js";
import { prisma } from "./shared/prisma.js";
import { configureLogger, drainLogs, logger } from "./shared/logger.js";
import { processOutboxMessage, requeueNotScannedFiles } from "./modules/files/outbox.processor.js";
import { scannerMode } from "./modules/files/antivirus.js";
import { purgeOldLogs } from "./modules/system-logs/system-logs.service.js";
import { notifyOverdueTasks } from "./modules/workflow/workflow.engine.js";

configureLogger({ source: "worker", directory: logRoot, persist: true, quietConsole: env.NODE_ENV === "production" });

const workerId = `worker-${randomUUID()}`;
const IDLE_DELAY_MS = 2_000;
const ERROR_DELAY_MS = 15_000;
const HOUSEKEEPING_INTERVAL_MS = 10 * 60 * 1000;
let running = true;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function claimMessage() {
  const stale = new Date(Date.now() - 5 * 60 * 1000);
  const candidate = await prisma.outboxMessage.findFirst({
    where: {
      processedAt: null,
      availableAt: { lte: new Date() },
      OR: [{ lockedAt: null }, { lockedAt: { lt: stale } }]
    },
    orderBy: { createdAt: "asc" }
  });
  if (!candidate) return null;
  const claimed = await prisma.outboxMessage.updateMany({
    where: { id: candidate.id, processedAt: null, OR: [{ lockedAt: null }, { lockedAt: { lt: stale } }] },
    data: { lockedAt: new Date(), lockedBy: workerId, attempts: { increment: 1 } }
  });
  return claimed.count === 1 ? candidate : null;
}

/** Prace okresowe: przypomnienia o zaległych zadaniach, sprzątanie wygasłych sesji i starych logów. */
async function housekeeping() {
  // Retencja logów pierwsza i osobno: awaria bazy w innych pracach nie może zatrzymać
  // sprzątania plików, które są wtedy jedynym zapisem logów.
  try {
    const purged = await purgeOldLogs(env.LOG_RETENTION_DAYS, logRoot);
    if (purged.rows || purged.files) logger.info("Usunięto stare logi techniczne", { ...purged, retentionDays: env.LOG_RETENTION_DAYS });
  } catch (error) {
    logger.error("Nie udało się usunąć starych logów z bazy (pliki sprzątnięto)", { workerId, error: errorMessage(error) });
  }
  // Pliki dodane przy wyłączonym skanowaniu wracają do kolejki, gdy skaner działa. W każdym obrocie prac
  // okresowych (pierwszy zaraz po starcie): chwilowy brak bazy przy starcie nie zostawi ich bez skanu na stałe.
  const requeued = await requeueNotScannedFiles();
  if (requeued) logger.info("Pliki dodane bez skanu wróciły do kolejki skanowania", { workerId, files: requeued, antivirus: scannerMode() });
  const reminded = await notifyOverdueTasks();
  if (reminded) logger.info("Wysłano przypomnienia o zaległych zadaniach", { workerId, tasks: reminded });
  await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } });
}

/** Tryb skanera przy starcie: ostrzeżenie dla trybu bez skanowania, błąd dla braku konfiguracji. */
function announceScanner() {
  const mode = scannerMode();
  if (mode === "disabled") logger.warn("Skanowanie antywirusowe WYŁĄCZONE (AV_SCANNER=disabled): nowe załączniki są dostępne bez skanu", { workerId });
  if (mode === "unconfigured") logger.error("Brak skanera antywirusowego: ustaw AV_SCANNER (defender, clamav albo disabled). Załączniki czekają na skan", { workerId });
}

async function loop() {
  logger.info("Worker uruchomiony", { workerId, antivirus: scannerMode() });
  announceScanner();
  let nextHousekeeping = 0;
  while (running) {
    // Cały obrót pętli jest chroniony: chwilowa utrata połączenia z bazą nie może zakończyć
    // workera, bo wtedy kolejne załączniki bez końca czekałyby na skan.
    try {
      if (Date.now() >= nextHousekeeping) {
        nextHousekeeping = Date.now() + HOUSEKEEPING_INTERVAL_MS;
        await housekeeping();
      }
      const message = await claimMessage();
      // Dopiero po udanym kontakcie z bazą; brak postępu przez 5 min oznacza unhealthy.
      if (env.WORKER_HEARTBEAT_FILE) {
        try { writeFileSync(env.WORKER_HEARTBEAT_FILE, new Date().toISOString()); }
        catch (error) { logger.warn("Nie udało się zapisać heartbeat workera", { workerId, error: errorMessage(error) }); }
      }
      if (!message) {
        await delay(IDLE_DELAY_MS);
        continue;
      }
      try {
        await processOutboxMessage(message, workerId);
      } catch (error) {
        logger.error("Nie udało się przetworzyć zadania w tle", { workerId, messageId: message.id, error: errorMessage(error) });
        await prisma.outboxMessage.update({
          where: { id: message.id },
          data: { lockedAt: null, lockedBy: null, lastError: errorMessage(error).slice(0, 1000), availableAt: new Date(Date.now() + 60_000) }
        });
      }
    } catch (error) {
      logger.error("Błąd pętli workera (np. brak połączenia z bazą)", { workerId, error: errorMessage(error) });
      await delay(ERROR_DELAY_MS);
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { running = false; });
}

loop().finally(async () => {
  await drainLogs();
  await prisma.$disconnect();
});
