import type { OutboxMessage } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_MAIL_MAX_ATTEMPTS } from "../../src/modules/notifications/task-mail.js";
import { processOutboxMessage } from "../../src/modules/files/outbox.processor.js";
import { SystemRole, TASK_MAIL_TOPIC } from "../../src/shared/domain.js";
import { decide, draftInvoice, emails, login, openTaskFor, prisma, startServer, submittedInvoice, userId, type Client, type TestServer } from "./helpers.js";

const mail = vi.hoisted(() => ({
  configured: true,
  sent: [] as Array<{ to: string; subject: string; text: string; messageId?: string }>,
  failure: null as null | Error
}));
vi.mock("../../src/shared/mailer.js", () => ({
  getSmtpSettings: async () => (mail.configured ? { host: "smtp.test.local", port: 25, secure: false, source: "env" } : null),
  sendMail: async (_settings: unknown, message: { to: string; subject: string; text: string; messageId?: string }) => {
    if (mail.failure) throw mail.failure;
    mail.sent.push(message);
  }
}));

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

function smtpError(responseCode?: number, code?: string) {
  return Object.assign(new Error("550 no such user adam.it@aprobis.local"), { responseCode, code });
}

describe("mail o nowym zadaniu", () => {
  let server: TestServer;
  let jan: Client, anna: Client, admin: Client;

  beforeAll(async () => {
    server = await startServer();
    jan = await login(server.baseUrl, "jan");
    anna = await login(server.baseUrl, "anna");
    admin = await login(server.baseUrl, "admin");
  });
  afterAll(async () => { await server.close(); });

  beforeEach(async () => {
    mail.configured = true;
    mail.sent.length = 0;
    mail.failure = null;
    auditHooks.failOn = null;
    await prisma.outboxMessage.deleteMany({ where: { topic: TASK_MAIL_TOPIC } });
    await prisma.userSubstitution.deleteMany();
  });

  const queued = () => prisma.outboxMessage.findMany({ where: { topic: TASK_MAIL_TOPIC }, orderBy: { createdAt: "asc" } });
  const reload = (id: string) => prisma.outboxMessage.findUniqueOrThrow({ where: { id } });
  const forUser = (messages: OutboxMessage[], id: string) => messages.filter((message) => JSON.parse(message.payloadJson).userId === id);
  const process = (message: OutboxMessage) => processOutboxMessage(message, "test-worker");

  it("nie zostawia maila, gdy złożenie dokumentu zostanie wycofane", async () => {
    const document = await draftInvoice(jan, "100");
    auditHooks.failOn = "WORKFLOW_STARTED";
    const response = await jan.post(`/documents/${document.id}/submit`);
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await queued()).toHaveLength(0);
  });

  it("wysyła link i numer, bez tytułu, typu, autora i kwoty", async () => {
    const document = await submittedInvoice(jan, "100");
    const [message] = forUser(await queued(), await userId(emails.anna));
    await process(message!);

    expect(mail.sent).toHaveLength(1);
    const sent = mail.sent[0]!;
    expect(sent.to).toBe(emails.anna);
    expect(sent.subject).toContain(document.number);
    expect(sent.text).toContain(`http://localhost:3000/documents/${document.id}`);
    expect(sent.messageId).toBe(`<outbox-${message!.id}@aprobis.local>`);
    for (const secret of ["Faktura", "Kontrahent", "Jan", "100", "FV/1"]) {
      expect(`${sent.subject}\n${sent.text.replace(document.number, "").replace(document.id, "")}`).not.toContain(secret);
    }
    expect((await reload(message!.id)).processedAt).not.toBeNull();
  });

  it("obejmuje zastępcę, a po wygaśnięciu zastępstwa do niego nie pisze", async () => {
    const substitute = await userId(emails.piotr);
    const substitution = await prisma.userSubstitution.create({
      data: { userId: await userId(emails.anna), substituteUserId: substitute, validFrom: new Date(Date.now() - 60_000), validTo: new Date(Date.now() + 3_600_000), scope: "ALL", isActive: true }
    });
    await submittedInvoice(jan, "100");
    const [message] = forUser(await queued(), substitute);
    expect(message).toBeDefined();

    await prisma.userSubstitution.update({ where: { id: substitution.id }, data: { validTo: new Date(Date.now() - 1_000) } });
    await process(message!);

    expect(mail.sent).toHaveLength(0);
    expect((await reload(message!.id)).lastError).toContain("nieaktualny");
  });

  it("po przekazaniu nie pisze do poprzedniej osoby, także przy sekwencji A→B→A", async () => {
    const document = await submittedInvoice(jan, "100");
    const annaId = await userId(emails.anna);
    const piotrId = await userId(emails.piotr);
    const [first] = forUser(await queued(), annaId);
    const task = await openTaskFor(anna, document.id);

    const moved = await anna.post(`/workflow/tasks/${task.id}/delegate`, { delegateToUserId: piotrId, expectedVersion: task.version });
    expect(moved.status).toBe(200);
    const back = await admin.post(`/workflow/tasks/${task.id}/reassign`, { assignToUserId: annaId, comment: "Powrót", expectedVersion: moved.body.version });
    expect(back.status).toBe(200);

    await process((await reload(first!.id)));
    const [, again] = forUser(await queued(), annaId);
    expect(mail.sent).toHaveLength(0);

    await process(again!);
    expect(mail.sent.map((item) => item.to)).toEqual([emails.anna]);
  });

  it("nie wysyła po decyzji i po wycofaniu dokumentu", async () => {
    const decided = await submittedInvoice(jan, "100");
    const annaId = await userId(emails.anna);
    const [afterDecision] = forUser(await queued(), annaId);
    expect((await decide(anna, await openTaskFor(anna, decided.id), "REJECT", "Nie")).status).toBeLessThan(300);
    await process(afterDecision!);

    await prisma.outboxMessage.deleteMany({ where: { topic: TASK_MAIL_TOPIC } });
    const cancelled = await submittedInvoice(jan, "100");
    const [afterCancel] = forUser(await queued(), annaId);
    const current = await jan.get(`/documents/${cancelled.id}`);
    expect((await jan.post(`/documents/${cancelled.id}/cancel`, { reason: "Pomyłka", expectedVersion: current.body.version })).status).toBeLessThan(300);
    await process(afterCancel!);

    expect(mail.sent).toHaveLength(0);
  });

  it("nie pisze po utracie roli pozwalającej decydować", async () => {
    await submittedInvoice(jan, "100");
    const annaId = await userId(emails.anna);
    const [message] = forUser(await queued(), annaId);
    const { role } = await prisma.user.findUniqueOrThrow({ where: { id: annaId }, select: { role: true } });
    await prisma.user.update({ where: { id: annaId }, data: { role: SystemRole.AUDITOR } });
    try {
      await process(message!);
    } finally {
      await prisma.user.update({ where: { id: annaId }, data: { role } });
    }
    expect(mail.sent).toHaveLength(0);
  });

  it("nie pisze do konta nieaktywnego", async () => {
    await submittedInvoice(jan, "100");
    const annaId = await userId(emails.anna);
    const [message] = forUser(await queued(), annaId);
    await prisma.user.update({ where: { id: annaId }, data: { isActive: false } });
    try {
      await process(message!);
    } finally {
      await prisma.user.update({ where: { id: annaId }, data: { isActive: true } });
    }
    expect(mail.sent).toHaveLength(0);
  });

  it("bez SMTP zamyka komunikat bez wysyłki", async () => {
    mail.configured = false;
    await submittedInvoice(jan, "100");
    const [message] = await queued();
    await process(message!);
    const closed = await reload(message!.id);
    expect(closed.processedAt).not.toBeNull();
    expect(closed.lastError).toContain("SMTP");
  });

  it("przy chwilowej awarii ponawia z odstępem i kończy dokładnie po 12 próbach", async () => {
    mail.failure = smtpError(undefined, "ETIMEDOUT");
    await submittedInvoice(jan, "100");
    const [message] = forUser(await queued(), await userId(emails.anna));
    expect(TASK_MAIL_MAX_ATTEMPTS).toBe(12);

    let attempts = 0;
    for (; attempts < 11; attempts += 1) {
      const before = Date.now();
      await process({ ...(await reload(message!.id)), attempts });
      const state = await reload(message!.id);
      expect(state.processedAt).toBeNull();
      expect(state.lockedAt).toBeNull();
      const minutes = Math.min(60, (attempts + 1) * 5);
      expect(state.availableAt.getTime()).toBeGreaterThanOrEqual(before + minutes * 60_000 - 1_000);
    }
    await process({ ...(await reload(message!.id)), attempts });
    const closed = await reload(message!.id);
    expect(closed.processedAt).not.toBeNull();
    expect(closed.lastError).toBe("SMTP: ETIMEDOUT");
  });

  it("trwałe odrzucenie 5xx kończy od razu i nie zapisuje adresu w błędzie", async () => {
    mail.failure = smtpError(550);
    await submittedInvoice(jan, "100");
    const [message] = forUser(await queued(), await userId(emails.anna));
    await process(message!);
    const closed = await reload(message!.id);
    expect(closed.processedAt).not.toBeNull();
    expect(closed.lastError).toBe("SMTP: 550");
  });
});
