import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fileStorageRoot } from "../../src/config/env.js";
import { OutboxTopic, processOutboxMessage } from "../../src/modules/files/outbox.processor.js";
import { decide, draftInvoice, login, openTaskFor, prisma, startServer, type Client, type TestServer } from "./helpers.js";

// Skaner w teście wykonuje akcję „w trakcie skanu”, żeby odtworzyć wyścig z usunięciem szkicu.
const scanHooks = vi.hoisted(() => ({ duringScan: null as null | (() => Promise<void>) }));
vi.mock("../../src/modules/files/antivirus.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/modules/files/antivirus.js")>()),
  scanFile: async () => {
    await scanHooks.duringScan?.();
    return { status: "CLEAN", message: "test" };
  }
}));

// Awaria zapisu audytu wymusza wycofanie całej transakcji usuwania.
const auditHooks = vi.hoisted(() => ({ failOn: null as string | null }));
vi.mock("../../src/shared/audit.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/shared/audit.js")>();
  return {
    ...original,
    writeAuditInTransaction: async (...args: Parameters<typeof original.writeAuditInTransaction>) => {
      if (auditHooks.failOn && args[1].action === auditHooks.failOn) throw new Error("awaria audytu w teście");
      return original.writeAuditInTransaction(...args);
    }
  };
});

describe("usuwanie szkiców", () => {
  let server: TestServer;
  let jan: Client, anna: Client, admin: Client;

  beforeAll(async () => {
    server = await startServer();
    jan = await login(server.baseUrl, "jan");
    anna = await login(server.baseUrl, "anna");
    admin = await login(server.baseUrl, "admin");
  });

  afterAll(async () => { await server.close(); });

  beforeEach(() => {
    scanHooks.duringScan = null;
    auditHooks.failOn = null;
  });

  async function draftWithFile() {
    const document = await draftInvoice(jan, "100");
    const form = new FormData();
    form.append("file", new Blob(["treść"], { type: "text/plain" }), "załącznik.txt");
    const uploaded = await jan.post(`/documents/${document.id}/files`, form);
    expect(uploaded.status).toBe(202);
    const record = await prisma.documentFile.findUniqueOrThrow({ where: { id: uploaded.body.id } });
    const detail = await jan.get(`/documents/${document.id}`);
    return { document, fileId: record.id, storagePath: record.storagePath, version: detail.body.version as number };
  }

  function deleteMessages(fileId: string) {
    return prisma.outboxMessage.findMany({ where: { topic: OutboxTopic.FILE_DELETE_REQUESTED, aggregateId: fileId } });
  }

  it("autor usuwa swój szkic: znika dokument i rekordy, audyt zostaje, plik usuwa worker", async () => {
    const { document, fileId, storagePath, version } = await draftWithFile();
    await jan.post(`/documents/${document.id}/comments`, { body: "notatka" });
    expect((await jan.get(`/documents/${document.id}`)).body.actionsAllowed.canDelete).toBe(true);

    expect((await jan.delete(`/documents/${document.id}?expectedVersion=${version}`)).status).toBe(204);

    expect((await jan.get(`/documents/${document.id}`)).status).toBe(404);
    expect(await prisma.document.count({ where: { id: document.id } })).toBe(0);
    expect(await prisma.documentFile.count({ where: { documentId: document.id } })).toBe(0);
    expect(await prisma.comment.count({ where: { documentId: document.id } })).toBe(0);
    expect(await prisma.documentFieldProjection.count({ where: { documentId: document.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { entityId: document.id, action: "DRAFT_DELETED" } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { entityId: document.id, eventType: "DRAFT_DELETED" } })).toBe(1);

    // Plik zostaje na dysku do czasu przetworzenia trwałego zlecenia.
    expect(fs.existsSync(storagePath)).toBe(true);
    const [message] = await deleteMessages(fileId);
    await processOutboxMessage(message, "test-worker");
    expect(fs.existsSync(storagePath)).toBe(false);
    expect((await prisma.outboxMessage.findUniqueOrThrow({ where: { id: message.id } })).processedAt).not.toBeNull();
  });

  it("cudzego szkicu nie usunie ani inna osoba, ani administrator", async () => {
    const document = await draftInvoice(jan, "100");
    expect((await anna.delete(`/documents/${document.id}?expectedVersion=${document.version}`)).status).toBe(403);
    expect((await admin.delete(`/documents/${document.id}?expectedVersion=${document.version}`)).status).toBe(403);
    expect((await admin.get(`/documents/${document.id}`)).body.actionsAllowed.canDelete).toBe(false);
    expect(await prisma.document.count({ where: { id: document.id } })).toBe(1);
  });

  it("dokumentu, który był w obiegu, nie da się usunąć — także po zwrocie do poprawy", async () => {
    const document = await draftInvoice(jan, "100");
    expect((await jan.post(`/documents/${document.id}/submit`)).status).toBe(201);
    await decide(anna, await openTaskFor(anna, document.id), "RETURN", "popraw");
    const detail = await jan.get(`/documents/${document.id}`);
    expect(detail.body.status).toBe("NEEDS_CORRECTION");
    expect(detail.body.actionsAllowed.canDelete).toBe(false);
    expect((await jan.delete(`/documents/${document.id}?expectedVersion=${detail.body.version}`)).status).toBe(409);
    expect(await prisma.document.count({ where: { id: document.id } })).toBe(1);
  });

  it("nieaktualna wersja kończy się konfliktem i niczego nie kasuje", async () => {
    const { document, fileId, version } = await draftWithFile();
    expect((await jan.delete(`/documents/${document.id}?expectedVersion=${version - 1}`)).status).toBe(409);
    expect(await prisma.documentFile.count({ where: { id: fileId } })).toBe(1);
    expect(await deleteMessages(fileId)).toHaveLength(0);
  });

  it("wycofana transakcja zostawia dokument, rekord pliku i plik, bez zlecenia usunięcia", async () => {
    const { document, fileId, storagePath, version } = await draftWithFile();
    auditHooks.failOn = "DRAFT_DELETED";
    expect((await jan.delete(`/documents/${document.id}?expectedVersion=${version}`)).status).toBe(500);
    expect(await prisma.document.count({ where: { id: document.id } })).toBe(1);
    expect(await prisma.documentFile.count({ where: { id: fileId } })).toBe(1);
    expect(fs.existsSync(storagePath)).toBe(true);
    expect(await deleteMessages(fileId)).toHaveLength(0);
  });

  it("równoczesne wysłanie i usunięcie: wygrywa jedno, bez stanu pośredniego", async () => {
    const document = await draftInvoice(jan, "100");
    const [submitted, deleted] = await Promise.all([
      jan.post(`/documents/${document.id}/submit`),
      jan.delete(`/documents/${document.id}?expectedVersion=${document.version}`)
    ]);
    const exists = await prisma.document.count({ where: { id: document.id } });
    if (deleted.status === 204) {
      expect(exists).toBe(0);
      expect(submitted.status).not.toBe(201);
    } else {
      expect(deleted.status).toBe(409);
      expect(submitted.status).toBe(201);
      expect(exists).toBe(1);
    }
  });

  it("usunięcie szkicu w trakcie skanu kończy komunikat skanu bez błędu i bez audytu skanu", async () => {
    const { document, fileId, version } = await draftWithFile();
    const scan = await prisma.outboxMessage.findFirstOrThrow({ where: { topic: OutboxTopic.FILE_SCAN_REQUESTED, aggregateId: fileId } });
    scanHooks.duringScan = async () => {
      expect((await jan.delete(`/documents/${document.id}?expectedVersion=${version}`)).status).toBe(204);
    };

    await processOutboxMessage(scan, "test-worker");

    const after = await prisma.outboxMessage.findUniqueOrThrow({ where: { id: scan.id } });
    expect(after.processedAt).not.toBeNull();
    expect(after.lastError).toBe("File record no longer exists");
    expect(await prisma.auditLog.count({ where: { entityId: fileId, action: { startsWith: "FILE_SCAN" } } })).toBe(0);
  });

  it("nieudane sprzątanie pliku zostaje w kolejce i udaje się przy ponowieniu", async () => {
    const blocked = path.join(fileStorageRoot, `test-blokada-${Date.now()}`);
    fs.mkdirSync(blocked); // unlink na katalogu się nie uda, jak na pliku trzymanym przez skaner
    const message = await prisma.outboxMessage.create({
      data: { topic: OutboxTopic.FILE_DELETE_REQUESTED, aggregateType: "DOCUMENT_FILE", aggregateId: "test", payloadJson: JSON.stringify({ storagePath: blocked }) }
    });

    await expect(processOutboxMessage(message, "test-worker")).rejects.toThrow();
    expect((await prisma.outboxMessage.findUniqueOrThrow({ where: { id: message.id } })).processedAt).toBeNull();

    fs.rmdirSync(blocked);
    fs.writeFileSync(blocked, "x");
    await processOutboxMessage(message, "test-worker");
    expect(fs.existsSync(blocked)).toBe(false);
    expect((await prisma.outboxMessage.findUniqueOrThrow({ where: { id: message.id } })).processedAt).not.toBeNull();
  });

  it("zlecenie ze ścieżką spoza katalogu załączników niczego nie kasuje", async () => {
    const outside = path.join(path.dirname(fileStorageRoot), `poza-${Date.now()}.txt`);
    fs.writeFileSync(outside, "nie ruszać");
    try {
      const message = await prisma.outboxMessage.create({
        data: { topic: OutboxTopic.FILE_DELETE_REQUESTED, aggregateType: "DOCUMENT_FILE", aggregateId: "test", payloadJson: JSON.stringify({ storagePath: outside }) }
      });
      await processOutboxMessage(message, "test-worker");
      expect(fs.existsSync(outside)).toBe(true);
      expect((await prisma.outboxMessage.findUniqueOrThrow({ where: { id: message.id } })).processedAt).not.toBeNull();
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});
