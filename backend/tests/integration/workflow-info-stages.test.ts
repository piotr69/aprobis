import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { processOutboxMessage } from "../../src/modules/files/outbox.processor.js";
import { STAGE_INFO_MAIL_TOPIC } from "../../src/shared/domain.js";
import { Client, decide, emails, login, openTaskFor, prisma, startServer, userId, type TestServer } from "./helpers.js";

const mail = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string; text: string; messageId?: string }> }));
vi.mock("../../src/shared/mailer.js", () => ({
  getSmtpSettings: async () => ({ host: "smtp.test.local", port: 25, secure: false, source: "env" }),
  sendMail: async (_settings: unknown, message: { to: string; subject: string; text: string; messageId?: string }) => {
    mail.sent.push(message);
  }
}));

/** Etapy „do wiadomości” (krok B propozycji „schematy-akceptacji”). */
describe("etapy do wiadomości", () => {
  let server: TestServer;
  let admin: Client, jan: Client, anna: Client, olga: Client, sekretariat: Client, piotr: Client, maria: Client;

  beforeAll(async () => {
    server = await startServer();
    admin = await login(server.baseUrl, "admin");
    jan = await login(server.baseUrl, "jan");
    anna = await login(server.baseUrl, "anna");
    olga = await login(server.baseUrl, "olga");
    sekretariat = await login(server.baseUrl, "sekretariat");
    piotr = await login(server.baseUrl, "piotr");
    maria = await login(server.baseUrl, "maria");
  });

  afterAll(async () => { await server.close(); });
  beforeEach(() => { mail.sent.length = 0; });

  async function newType() {
    // Kategoria HR: sekretariat i zakupy nie mają do niej wglądu z roli, więc widać wyłącznie wgląd „do wiadomości”.
    const code = `INFO_${Date.now()}_${Math.round(Math.random() * 1000)}`;
    const type = await admin.post("/document-types", { name: code, code, category: "HR" });
    expect(type.status).toBe(201);
    await admin.post(`/document-types/${type.body.id}/versions/${type.body.draftVersion.id}/publish`);
    return type.body.id as string;
  }

  const manager = (name = "Przełożony", stageNo?: number) => ({ name, stepType: "MANAGER_APPROVAL", order: 1, stageNo, assigneeType: "MANAGER" });
  const info = async (list: string[], name = "Do wiadomości", stageNo?: number) => ({
    name, stepType: "BUSINESS_APPROVAL", stageKind: "INFO", order: 1, stageNo, assigneeType: "USER",
    assignees: await Promise.all(list.map(async (email) => ({ assigneeType: "USER", userId: await userId(email) })))
  });
  const person = async (email: string, name: string, stageNo: number, parallelGroup = 1) => ({
    name, stepType: "BUSINESS_APPROVAL", order: 1, stageNo, parallelGroup, assigneeType: "USER", assigneeUserId: await userId(email)
  });

  async function publish(typeId: string, steps: Array<Record<string, unknown>>) {
    const saved = await admin.post("/rules/workflow-definitions", { name: "Schemat z informacją", documentTypeId: typeId, steps });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const published = await admin.post(`/rules/workflow-definitions/${saved.body.id}/publish`);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
  }

  async function submit(typeId: string) {
    const document = await jan.post("/documents", { title: "Wniosek urlopowy testowy", typeId });
    expect(document.status).toBe(201);
    const submitted = await jan.post(`/documents/${document.body.id}/submit`);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    return document.body.id as string;
  }

  const grants = (documentId: string) => prisma.workflowStageRecipient.findMany({ where: { documentId }, orderBy: { createdAt: "asc" } });

  async function processInfoMails(documentId: string) {
    const recipients = await grants(documentId);
    const messages = await prisma.outboxMessage.findMany({
      where: { topic: STAGE_INFO_MAIL_TOPIC, aggregateId: { in: recipients.map((item) => item.id) }, processedAt: null }
    });
    for (const message of messages) await processOutboxMessage({ ...message, attempts: 0 }, "test-worker");
    return prisma.outboxMessage.findMany({ where: { id: { in: messages.map((message) => message.id) } } });
  }

  it("przełożony, potem do wiadomości: zatwierdzenie po decyzji, odbiorca widzi treść bez notatek i bez zadania", async () => {
    const typeId = await newType();
    await publish(typeId, [manager(), { ...(await info([emails.sekretariat, emails.olga])), order: 2 }]);
    const id = await submit(typeId);
    expect((await sekretariat.get(`/documents/${id}`)).status).toBe(403);

    expect((await anna.post(`/documents/${id}/comments`, { body: "Notatka wewnętrzna przełożonego", visibility: "INTERNAL" })).status).toBe(201);
    expect((await decide(anna, await openTaskFor(anna, id), "APPROVE")).body.status).toBe("APPROVED");

    const detail = await sekretariat.get(`/documents/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.comments.map((comment: any) => comment.body)).not.toContain("Notatka wewnętrzna przełożonego");
    expect(detail.body.actionsAllowed.canComment).toBe(false);
    expect((await sekretariat.get(`/documents/${id}/files`)).status).toBe(200);
    expect((await sekretariat.post(`/documents/${id}/comments`, { body: "Próba" })).status).toBe(403);
    expect(await openTaskFor(sekretariat, id)).toBeUndefined();
    const listed = await sekretariat.get("/documents");
    expect(JSON.stringify(listed.body)).toContain(id);

    const notification = await prisma.notification.findFirst({ where: { documentId: id, userId: await userId(emails.sekretariat), type: "STAGE_INFO" } });
    expect(notification).not.toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { entityId: id, action: "STAGE_INFO_QUEUED" } });
    expect(JSON.parse(audit!.afterJson!).userIds).toHaveLength(2);

    // Worker wysyła mail także po zatwierdzeniu dokumentu, bez tytułu i bez prośby o decyzję.
    const processed = await processInfoMails(id);
    expect(processed.every((message) => message.processedAt && !message.lastError)).toBe(true);
    expect(mail.sent.map((message) => message.to).sort()).toEqual([emails.olga, emails.sekretariat].sort());
    expect(mail.sent[0].subject).toContain("do wiadomości");
    expect(mail.sent[0].text).not.toContain("Wniosek urlopowy testowy");
  });

  it("do wiadomości na początku daje wgląd od razu, a dokument czeka na decyzję", async () => {
    const typeId = await newType();
    await publish(typeId, [await info([emails.olga]), { ...manager(), order: 2 }]);
    const id = await submit(typeId);
    expect((await olga.get(`/documents/${id}`)).status).toBe(200);
    const document = await prisma.document.findUniqueOrThrow({ where: { id } });
    expect(document.status).toBe("IN_APPROVAL");
    expect(document.currentStepName).toBe("Przełożony");
  });

  it("dwa etapy do wiadomości z rzędu realizują się razem po decyzji", async () => {
    const typeId = await newType();
    await publish(typeId, [manager(), { ...(await info([emails.olga], "Zakupy")), order: 2 }, { ...(await info([emails.sekretariat], "Sekretariat")), order: 3 }]);
    const id = await submit(typeId);
    expect(await grants(id)).toHaveLength(0);
    expect((await decide(anna, await openTaskFor(anna, id), "APPROVE")).body.status).toBe("APPROVED");
    expect((await grants(id)).map((grant) => grant.status)).toEqual(["GRANTED", "GRANTED"]);
  });

  it("równoległe decyzje: informacja dopiero po obu, a odrzucenie drugiej jej nie wysyła", async () => {
    const typeId = await newType();
    await publish(typeId, [
      await person(emails.piotr, "Dyrektor", 1, 1),
      await person(emails.maria, "Księgowość", 1, 2),
      { ...(await info([emails.olga], "Zakupy", 2)), order: 3 }
    ]);
    const approved = await submit(typeId);
    expect((await decide(piotr, await openTaskFor(piotr, approved), "APPROVE")).body.status).toBe("STAGE_IN_PROGRESS");
    expect(await grants(approved)).toHaveLength(0);
    expect((await decide(maria, await openTaskFor(maria, approved), "APPROVE")).body.status).toBe("APPROVED");
    expect(await grants(approved)).toHaveLength(1);

    const rejected = await submit(typeId);
    await decide(piotr, await openTaskFor(piotr, rejected), "APPROVE");
    expect((await decide(maria, await openTaskFor(maria, rejected), "REJECT", "Nie")).body.status).toBe("REJECTED");
    expect(await grants(rejected)).toHaveLength(0);
  });

  it("brak aktywnego odbiorcy: etap pominięty z wpisem w historii, dokument zatwierdzony", async () => {
    const typeId = await newType();
    await publish(typeId, [manager(), { ...(await info([emails.olga])), order: 2 }]);
    const id = await submit(typeId);
    const olgaId = await userId(emails.olga);
    await prisma.user.update({ where: { id: olgaId }, data: { isActive: false } });
    try {
      expect((await decide(anna, await openTaskFor(anna, id), "APPROVE")).body.status).toBe("APPROVED");
    } finally {
      await prisma.user.update({ where: { id: olgaId }, data: { isActive: true } });
    }
    const stage = await prisma.workflowInstanceStage.findFirstOrThrow({ where: { instance: { documentId: id }, stageKind: "INFO" } });
    expect(stage.status).toBe("SKIPPED");
    expect(await prisma.auditLog.count({ where: { entityId: id, action: "STAGE_INFO_SKIPPED" } })).toBe(1);
  });

  it("zwrot do poprawy cofa wgląd i mail; ponowne złożenie nadaje go od nowa po dojściu obiegu", async () => {
    const typeId = await newType();
    await publish(typeId, [manager("Przełożony", 1), { ...(await info([emails.olga], "Zakupy", 2)), order: 2 }, { ...(await person(emails.piotr, "Dyrektor", 3)), order: 3 }]);
    const id = await submit(typeId);
    await decide(anna, await openTaskFor(anna, id), "APPROVE");
    expect((await olga.get(`/documents/${id}`)).status).toBe(200);

    expect((await decide(piotr, await openTaskFor(piotr, id), "RETURN", "Popraw daty")).body.status).toBe("NEEDS_CORRECTION");
    expect((await olga.get(`/documents/${id}`)).status).toBe(403);
    const processed = await processInfoMails(id);
    expect(processed[0].lastError).toContain("Wgląd cofnięty");
    expect(mail.sent).toHaveLength(0);

    expect((await jan.post(`/documents/${id}/submit`)).status).toBe(201);
    expect((await olga.get(`/documents/${id}`)).status).toBe(403);
    await decide(anna, await openTaskFor(anna, id), "APPROVE");
    expect((await olga.get(`/documents/${id}`)).status).toBe(200);
    expect((await grants(id)).map((grant) => grant.status)).toEqual(["REVOKED", "GRANTED"]);
  });

  it("trwający obieg używa adresatów z chwili złożenia, nie z nowej wersji schematu", async () => {
    const typeId = await newType();
    await publish(typeId, [manager(), { ...(await info([emails.olga])), order: 2 }]);
    const id = await submit(typeId);
    await publish(typeId, [manager(), { ...(await info([emails.sekretariat])), order: 2 }]);
    await decide(anna, await openTaskFor(anna, id), "APPROVE");
    expect((await grants(id)).map((grant) => grant.userId)).toEqual([await userId(emails.olga)]);
  });

  it("równoległe decyzje w etapie ALL dają jeden komplet wglądu, powiadomienia i maila", async () => {
    const typeId = await newType();
    await publish(typeId, [
      { name: "Oboje", stepType: "BUSINESS_APPROVAL", order: 1, assigneeType: "USER", completionMode: "ALL", assignees: [{ assigneeType: "USER", userId: await userId(emails.piotr) }, { assigneeType: "USER", userId: await userId(emails.maria) }] },
      { ...(await info([emails.olga])), order: 2 }
    ]);
    const id = await submit(typeId);
    const results = await Promise.all([
      decide(piotr, await openTaskFor(piotr, id), "APPROVE"),
      decide(maria, await openTaskFor(maria, id), "APPROVE")
    ]);
    for (const [index, result] of results.entries()) {
      if (result.status !== 200) {
        const client = index === 0 ? piotr : maria;
        expect((await decide(client, await openTaskFor(client, id), "APPROVE")).status).toBe(200);
      }
    }
    const recipients = await grants(id);
    expect(recipients).toHaveLength(1);
    expect(await prisma.outboxMessage.count({ where: { topic: STAGE_INFO_MAIL_TOPIC, aggregateId: recipients[0].id } })).toBe(1);
    expect(await prisma.notification.count({ where: { documentId: id, type: "STAGE_INFO" } })).toBe(1);
  });

  it("walidacja schematu: bez decyzji, mieszany etap, rola i pola decyzji w etapie do wiadomości", async () => {
    const typeId = await newType();
    const save = (steps: Array<Record<string, unknown>>) => admin.post("/rules/workflow-definitions", { name: "Zły", documentTypeId: typeId, steps });
    expect((await save([await info([emails.olga])])).status).toBe(400);
    expect((await save([manager("A", 1), { ...(await info([emails.olga], "B", 1)), parallelGroup: 2, order: 2 }])).status).toBe(400);
    expect((await save([manager(), { name: "Rola", stepType: "BUSINESS_APPROVAL", stageKind: "INFO", order: 2, assigneeType: "ROLE", assigneeRole: "HR" }])).status).toBe(400);
    expect((await save([manager(), { ...(await info([emails.olga])), order: 2, requiresComment: true }])).status).toBe(400);
    expect((await save([manager(), { ...(await info([emails.olga])), order: 2, stageKind: "COS_INNEGO" }])).status).toBe(400);
    // KB02: zagnieżdżony adresat innego rodzaju niż osoba jest odrzucany, sam i obok poprawnej osoby.
    const role = await prisma.role.findFirstOrThrow({ where: { code: "HR" } });
    const nestedRole = { name: "Rola w środku", stepType: "BUSINESS_APPROVAL", stageKind: "INFO", order: 2, assigneeType: "USER", assignees: [{ assigneeType: "ROLE", roleId: role.id }] };
    expect((await save([manager(), nestedRole])).status).toBe(400);
    expect((await save([manager(), { ...nestedRole, assignees: [{ assigneeType: "USER", userId: await userId(emails.olga) }, { assigneeType: "ROLE", roleId: role.id }] }])).status).toBe(400);
    expect((await save([manager(), { name: "Przełożony z listą", stepType: "BUSINESS_APPROVAL", stageKind: "INFO", order: 2, assigneeType: "MANAGER", assignees: [{ assigneeType: "USER", userId: await userId(emails.olga) }] }])).status).toBe(400);
  });

  it("do wiadomości można przekazać osobie bez prawa decyzji", async () => {
    const typeId = await newType();
    await publish(typeId, [manager(), { ...(await info([emails.audytor])), order: 2 }]);
  });

  it("podgląd ścieżki pokazuje etap do wiadomości z odbiorcami", async () => {
    const typeId = await newType();
    await publish(typeId, [manager(), { ...(await info([emails.olga])), order: 2 }]);
    const document = await jan.post("/documents", { title: "Podgląd", typeId });
    const preview = await jan.get(`/documents/${document.body.id}/workflow-preview`);
    expect(preview.body.stages[1]).toMatchObject({ stageKind: "INFO", approvers: ["Olga Zakupy"] });
  });
});
