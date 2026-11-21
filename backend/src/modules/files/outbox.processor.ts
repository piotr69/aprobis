import fs from "node:fs";
import path from "node:path";
import type { OutboxMessage } from "@prisma/client";
import { fileStorageRoot } from "../../config/env.js";
import { prisma } from "../../shared/prisma.js";
import { writeAuditInTransaction } from "../../shared/audit.js";
import { STAGE_INFO_MAIL_TOPIC, TASK_MAIL_TOPIC } from "../../shared/domain.js";
import { processTaskMail } from "../notifications/task-mail.js";
import { processStageInfoMail } from "../notifications/stage-info-mail.js";
import { scanFile, scannerMode, type ScannerMode } from "./antivirus.js";

export const OutboxTopic = {
  FILE_SCAN_REQUESTED: "file.scan.requested",
  /** Fizyczne usunięcie załącznika po skasowaniu rekordu; ponawiane do skutku. */
  FILE_DELETE_REQUESTED: "file.delete.requested"
} as const;

const RECORD_GONE = "File record no longer exists";

function markProcessed(messageId: string, lastError: string | null = null) {
  return prisma.outboxMessage.update({
    where: { id: messageId },
    data: { processedAt: new Date(), lastError, lockedAt: null, lockedBy: null }
  });
}

/** Czy ścieżka leży w katalogu załączników; komunikat z bazy nie może skasować niczego poza nim. */
export function isInsideStorageRoot(storagePath: string, root: string = fileStorageRoot) {
  const resolved = path.resolve(storagePath);
  return resolved.startsWith(root + path.sep);
}

async function deleteStoredFile(message: OutboxMessage) {
  const { storagePath } = JSON.parse(message.payloadJson) as { storagePath?: string };
  if (!storagePath || !isInsideStorageRoot(storagePath)) {
    await markProcessed(message.id, "Ścieżka pliku poza katalogiem załączników — pominięto");
    return;
  }
  try {
    await fs.promises.unlink(path.resolve(storagePath));
  } catch (error) {
    // Brak pliku to cel osiągnięty. Inne błędy (np. plik trzymany przez skaner) wracają
    // do pętli workera, która ponowi komunikat później.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await markProcessed(message.id);
}

async function scanStoredFile(message: OutboxMessage, workerId: string) {
  const file = await prisma.documentFile.findUnique({ where: { id: message.aggregateId } });
  if (!file) {
    await markProcessed(message.id, RECORD_GONE);
    return;
  }

  const result = await scanFile(file.storagePath);
  // Szkic mógł zostać usunięty w trakcie skanu, dlatego zapis wyniku to updateMany:
  // brak rekordu kończy komunikat bez błędu i bez wpisu audytu o nieistniejącym pliku.
  if (result.status === "UNAVAILABLE") {
    const attempts = message.attempts + 1;
    const gone = await prisma.$transaction(async (tx) => {
      const updated = await tx.documentFile.updateMany({ where: { id: file.id }, data: { scanStatus: "PENDING", scanMessage: result.message } });
      if (updated.count === 0) return true;
      await tx.outboxMessage.update({
        where: { id: message.id },
        data: {
          lockedAt: null,
          lockedBy: null,
          lastError: result.message,
          availableAt: new Date(Date.now() + Math.min(60, attempts * 5) * 60 * 1000)
        }
      });
      return false;
    });
    if (gone) await markProcessed(message.id, RECORD_GONE);
    return;
  }

  const gone = await prisma.$transaction(async (tx) => {
    const updated = await tx.documentFile.updateMany({
      where: { id: file.id },
      // NOT_SCANNED: skan się nie odbył, więc bez daty skanu.
      data: { scanStatus: result.status, scanMessage: result.message, scannedAt: result.status === "NOT_SCANNED" ? null : new Date() }
    });
    if (updated.count === 0) return true;
    await tx.outboxMessage.update({
      where: { id: message.id },
      data: { processedAt: new Date(), lockedAt: null, lockedBy: null, lastError: result.status === "REJECTED" ? result.message : null }
    });
    await writeAuditInTransaction(tx, {
      entityType: "DOCUMENT_FILE",
      entityId: file.id,
      action: result.status === "CLEAN" ? "FILE_SCAN_CLEAN" : result.status === "NOT_SCANNED" ? "FILE_SCAN_SKIPPED" : "FILE_SCAN_REJECTED",
      after: { documentId: file.documentId, status: result.status },
      correlationId: workerId
    });
    return false;
  });
  if (gone) await markProcessed(message.id, RECORD_GONE);
}

/**
 * Po włączeniu skanera pliki pominięte w trybie disabled wracają do kolejki (PENDING + komunikat skanu),
 * żeby nie dało się ich pobrać bez werdyktu. Idempotentne: dotyka tylko plików nadal NOT_SCANNED.
 */
export async function requeueNotScannedFiles(mode: ScannerMode = scannerMode()) {
  // Tylko przy działającym skanerze: bez niego komunikaty od razu wpadłyby w narastające opóźnienie ponowień.
  if (mode !== "defender" && mode !== "clamav") return 0;
  const files = await prisma.documentFile.findMany({ where: { scanStatus: "NOT_SCANNED" }, select: { id: true, storagePath: true, sha256: true } });
  let requeued = 0;
  for (const file of files) {
    const moved = await prisma.$transaction(async (tx) => {
      const updated = await tx.documentFile.updateMany({
        where: { id: file.id, scanStatus: "NOT_SCANNED" },
        data: { scanStatus: "PENDING", scanMessage: "Ponowny skan po włączeniu antywirusa" }
      });
      if (updated.count === 0) return false;
      await tx.outboxMessage.create({
        data: {
          topic: OutboxTopic.FILE_SCAN_REQUESTED,
          aggregateType: "DOCUMENT_FILE",
          aggregateId: file.id,
          payloadJson: JSON.stringify({ fileId: file.id, storagePath: file.storagePath, sha256: file.sha256 })
        }
      });
      return true;
    });
    if (moved) requeued += 1;
  }
  return requeued;
}

/** Obsługa jednego przejętego komunikatu outboxa. Błąd rzucony stąd worker ponawia za minutę. */
export async function processOutboxMessage(message: OutboxMessage, workerId: string) {
  switch (message.topic) {
    case OutboxTopic.FILE_SCAN_REQUESTED:
      return scanStoredFile(message, workerId);
    case OutboxTopic.FILE_DELETE_REQUESTED:
      return deleteStoredFile(message);
    case TASK_MAIL_TOPIC:
      await processTaskMail(message);
      return;
    case STAGE_INFO_MAIL_TOPIC:
      await processStageInfoMail(message);
      return;
    default:
      await markProcessed(message.id);
  }
}
