import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client, decide, emails, login, openTaskFor, prisma, startServer, userId, type TestServer } from "./helpers.js";

/**
 * KB01: zmiana podstawy wglądu w trakcie odczytu. Hook po kontroli dostępu uruchamia — bez czekania, jak równoległe
 * żądanie — zwrot do poprawy z nową treścią albo przepisanie zadania z nową notatką. Kontrola i odczyt są w jednej
 * transakcji Serializable, więc odpowiedź pokazuje stan sprzed zmiany albo odmawia, ale nigdy nowej treści.
 */
const hooks = vi.hoisted(() => ({ afterAccess: null as null | (() => Promise<void>), pending: null as null | Promise<void> }));
vi.mock("../../src/shared/access.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/shared/access.js")>();
  return {
    ...original,
    assertDocumentAccess: async (...args: Parameters<typeof original.assertDocumentAccess>) => {
      const result = await original.assertDocumentAccess(...args);
      const hook = hooks.afterAccess;
      hooks.afterAccess = null;
      if (hook) hooks.pending = hook();
      return result;
    }
  };
});

describe("wyścig zmiany wglądu do wiadomości z odczytem", () => {
  let server: TestServer;
  let admin: Client, jan: Client, anna: Client, olga: Client;

  beforeAll(async () => {
    server = await startServer();
    admin = await login(server.baseUrl, "admin");
    jan = await login(server.baseUrl, "jan");
    anna = await login(server.baseUrl, "anna");
    olga = await login(server.baseUrl, "olga");
  });

  afterAll(async () => { await server.close(); });

  /** Przełożony → Zakupy (Olga, do wiadomości) → Dyrektor; po decyzji przełożonego Olga ma wgląd INFO. */
  async function grantedDocument(finalApprover = emails.piotr) {
    const code = `WYSCIG_${Date.now()}_${Math.round(Math.random() * 1000)}`;
    const type = await admin.post("/document-types", { name: code, code, category: "HR" });
    await admin.post(`/document-types/${type.body.id}/versions/${type.body.draftVersion.id}/publish`);
    const saved = await admin.post("/rules/workflow-definitions", {
      name: "Wyścig",
      documentTypeId: type.body.id,
      steps: [
        { name: "Przełożony", stepType: "MANAGER_APPROVAL", order: 1, stageNo: 1, assigneeType: "MANAGER" },
        { name: "Zakupy", stepType: "BUSINESS_APPROVAL", stageKind: "INFO", order: 2, stageNo: 2, assigneeType: "USER", assignees: [{ assigneeType: "USER", userId: await userId(emails.olga) }] },
        { name: "Ostatnia decyzja", stepType: "BUSINESS_APPROVAL", order: 3, stageNo: 3, assigneeType: "USER", assigneeUserId: await userId(finalApprover) }
      ]
    });
    expect((await admin.post(`/rules/workflow-definitions/${saved.body.id}/publish`)).status).toBe(200);
    const document = await jan.post("/documents", { title: "Treść przed korektą", typeId: type.body.id });
    await jan.post(`/documents/${document.body.id}/submit`);
    await decide(anna, await openTaskFor(anna, document.body.id), "APPROVE");
    return document.body.id as string;
  }

  /** Jak RETURN i zapis korekty: najpierw cofnięcie wglądu, potem nowa, prywatna treść. */
  const returnAndCorrect = (documentId: string) => async () => {
    await prisma.workflowStageRecipient.updateMany({ where: { documentId }, data: { status: "REVOKED", revokedAt: new Date() } });
    await prisma.document.update({ where: { id: documentId }, data: { title: "NOWA PRYWATNA KOREKTA", status: "NEEDS_CORRECTION" } });
  };

  async function settle() {
    await hooks.pending;
    hooks.pending = null;
  }

  it("szczegóły dokumentu: cofnięcie wglądu w trakcie odczytu nie ujawnia nowej treści", async () => {
    const id = await grantedDocument();
    hooks.afterAccess = returnAndCorrect(id);
    const response = await olga.get(`/documents/${id}`);
    await settle();
    expect([200, 403]).toContain(response.status);
    expect(JSON.stringify(response.body)).not.toContain("NOWA PRYWATNA KOREKTA");
    expect((await olga.get(`/documents/${id}`)).status).toBe(403);
  });

  it("lista plików: cofnięcie wglądu w trakcie odczytu nie pokazuje plików korekty", async () => {
    const id = await grantedDocument();
    hooks.afterAccess = returnAndCorrect(id);
    const response = await olga.get(`/documents/${id}/files`);
    await settle();
    expect(response.body).toEqual([]);
  });

  it("szczegóły zadania: cofnięcie wglądu w trakcie odczytu nie ujawnia tytułu korekty", async () => {
    const id = await grantedDocument();
    const task = await prisma.workflowTask.findFirstOrThrow({ where: { documentId: id, name: "Przełożony" } });
    hooks.afterAccess = returnAndCorrect(id);
    const response = await olga.get(`/workflow/tasks/${task.id}`);
    await settle();
    expect(JSON.stringify(response.body)).not.toContain("NOWA PRYWATNA KOREKTA");
    expect((await olga.get(`/workflow/tasks/${task.id}`)).status).toBe(403);
  });

  it("przepisanie zadania w trakcie odczytu: zostaje wgląd INFO, a nowa notatka wewnętrzna nie wycieka", async () => {
    // Olga ma wgląd INFO i jednocześnie ostatnie zadanie decyzji; administrator przepisuje je komuś innemu.
    const id = await grantedDocument(emails.olga);
    const task = await prisma.workflowTask.findFirstOrThrow({ where: { documentId: id, status: "OPEN" } });
    expect(task.assignedToId).toBe(await userId(emails.olga));
    hooks.afterAccess = async () => {
      await prisma.workflowTask.update({ where: { id: task.id }, data: { assignedToId: await userId(emails.piotr), version: { increment: 1 } } });
      await prisma.comment.create({ data: { documentId: id, userId: await userId(emails.anna), body: "NOWA NOTATKA WEWNĘTRZNA", visibility: "INTERNAL" } });
    };
    const response = await olga.get(`/documents/${id}`);
    await settle();
    expect(JSON.stringify(response.body)).not.toContain("NOWA NOTATKA WEWNĘTRZNA");
    const after = await olga.get(`/documents/${id}`);
    expect(after.status).toBe(200);
    expect(JSON.stringify(after.body)).not.toContain("NOWA NOTATKA WEWNĘTRZNA");
  });
});
