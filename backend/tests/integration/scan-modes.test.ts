import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "./helpers.js";

// Skaner w trybie „wyłączony” — tak jak przy AV_SCANNER=disabled.
vi.mock("../../src/modules/files/antivirus.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/modules/files/antivirus.js")>()),
  scanFile: async () => ({ status: "NOT_SCANNED", message: "Skanowanie antywirusowe wyłączone (AV_SCANNER=disabled)" })
}));

const { OutboxTopic, processOutboxMessage, requeueNotScannedFiles } = await import("../../src/modules/files/outbox.processor.js");

describe("tryby skanera w workerze", () => {
  const created: string[] = [];

  async function pendingFile() {
    const doc = await prisma.document.findFirstOrThrow({ where: { status: "DRAFT" }, select: { id: true, authorId: true } });
    const file = await prisma.documentFile.create({
      data: {
        documentId: doc.id, version: 900 + created.length, originalName: "skan.pdf", storagePath: "/nie/istnieje/skan.pdf",
        mimeType: "application/pdf", sha256: "0".repeat(64), scanStatus: "PENDING", size: 10, uploadedById: doc.authorId
      }
    });
    created.push(file.id);
    const message = await prisma.outboxMessage.create({
      data: { topic: OutboxTopic.FILE_SCAN_REQUESTED, aggregateType: "DOCUMENT_FILE", aggregateId: file.id, payloadJson: JSON.stringify({ fileId: file.id }) }
    });
    return { file, message };
  }

  afterAll(async () => {
    await prisma.outboxMessage.deleteMany({ where: { aggregateId: { in: created } } });
    await prisma.documentFile.deleteMany({ where: { id: { in: created } } });
  });

  it("tryb wyłączony: plik dostaje NOT_SCANNED bez daty skanu i wpis FILE_SCAN_SKIPPED", async () => {
    const { file, message } = await pendingFile();
    await processOutboxMessage(message, "test-worker");
    const after = await prisma.documentFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(after.scanStatus).toBe("NOT_SCANNED");
    expect(after.scannedAt).toBeNull();
    expect(await prisma.auditEvent.count({ where: { entityId: file.id, eventType: "FILE_SCAN_SKIPPED" } })).toBe(1);
    expect((await prisma.outboxMessage.findUniqueOrThrow({ where: { id: message.id } })).processedAt).not.toBeNull();
  });

  it("po włączeniu skanera pliki NOT_SCANNED wracają do kolejki dokładnie raz", async () => {
    const { file, message } = await pendingFile();
    await processOutboxMessage(message, "test-worker");
    expect(await requeueNotScannedFiles("disabled")).toBe(0);
    expect(await requeueNotScannedFiles("unconfigured")).toBe(0);
    expect((await prisma.documentFile.findUniqueOrThrow({ where: { id: file.id } })).scanStatus).toBe("NOT_SCANNED");

    expect(await requeueNotScannedFiles("clamav")).toBeGreaterThanOrEqual(1);
    const after = await prisma.documentFile.findUniqueOrThrow({ where: { id: file.id } });
    expect(after.scanStatus).toBe("PENDING");
    const queued = await prisma.outboxMessage.count({ where: { aggregateId: file.id, topic: OutboxTopic.FILE_SCAN_REQUESTED, processedAt: null } });
    expect(queued).toBe(1);

    expect(await requeueNotScannedFiles("clamav")).toBe(0);
    expect(await prisma.outboxMessage.count({ where: { aggregateId: file.id, topic: OutboxTopic.FILE_SCAN_REQUESTED, processedAt: null } })).toBe(1);
  });
});
