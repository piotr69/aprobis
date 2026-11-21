import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decide, emails, login, openTaskFor, startServer, submittedInvoice, userId, type Client, type TestServer } from "./helpers.js";

describe("osobiste listy pracy", () => {
  let server: TestServer;
  let jan: Client, anna: Client, maria: Client, ewa: Client, marek: Client, piotr: Client, admin: Client, audytor: Client;

  beforeAll(async () => {
    server = await startServer();
    jan = await login(server.baseUrl, "jan");
    anna = await login(server.baseUrl, "anna");
    maria = await login(server.baseUrl, "maria");
    ewa = await login(server.baseUrl, "ewa");
    marek = await login(server.baseUrl, "marek");
    piotr = await login(server.baseUrl, "piotr");
    admin = await login(server.baseUrl, "admin");
    audytor = await login(server.baseUrl, "audytor");
  });

  afterAll(async () => { await server.close(); });

  async function atBoardStage() {
    const document = await submittedInvoice(jan, "60000");
    await decide(anna, await openTaskFor(anna, document.id), "APPROVE");
    await decide(maria, await openTaskFor(maria, document.id), "APPROVE");
    return document;
  }

  it("szeroki wgląd z roli nie tworzy zadania: księgowość widzi fakturę, ale zadanie ma tylko przełożony", async () => {
    const document = await submittedInvoice(jan, "1000");
    expect((await maria.get(`/documents/${document.id}`)).status).toBe(200);
    expect(await openTaskFor(maria, document.id)).toBeUndefined();
    expect(await openTaskFor(ewa, document.id)).toBeUndefined();
    expect(await openTaskFor(anna, document.id)).toBeTruthy();
  });

  it("zadanie przypisane konkretnej osobie nie pojawia się u reszty jej roli", async () => {
    const document = await atBoardStage();
    const task = await openTaskFor(ewa, document.id);
    expect(await openTaskFor(marek, document.id)).toBeTruthy();
    await ewa.post(`/workflow/tasks/${task.id}/delegate`, { delegateToUserId: await userId(emails.piotr), expectedVersion: task.version });
    expect(await openTaskFor(ewa, document.id)).toBeUndefined();
    expect(await openTaskFor(marek, document.id)).toBeUndefined();
    expect(await openTaskFor(piotr, document.id)).toBeTruthy();
    expect((await decide(marek, task, "APPROVE")).status).toBe(403);
  });

  it("role bez prawa decyzji mają pustą listę zadań", async () => {
    expect((await admin.get("/workflow/tasks/my")).body).toEqual([]);
    expect((await audytor.get("/workflow/tasks/my")).body).toEqual([]);
  });

  it("decyzja kolegi z tej samej roli nie udaje mojej", async () => {
    const document = await atBoardStage();
    await decide(ewa, await openTaskFor(ewa, document.id), "APPROVE");
    const mine = async (client: Client) => (await client.get("/workflow/actions/my?limit=100")).body.items.filter((item: any) => item.document.id === document.id);
    expect((await mine(ewa)).map((item: any) => item.actionType)).toEqual(["APPROVE"]);
    expect(await mine(marek)).toEqual([]);
    expect((await mine(jan)).map((item: any) => item.actionType)).toEqual(["SUBMIT"]);
  });

  it("moja decyzja to nie koniec obiegu: wpis pokazuje, że dokument idzie dalej", async () => {
    const document = await submittedInvoice(jan, "60000");
    await decide(anna, await openTaskFor(anna, document.id), "APPROVE");
    const history = await anna.get("/workflow/actions/my?limit=100");
    const entry = history.body.items.find((item: any) => item.document.id === document.id);
    expect(entry.actionType).toBe("APPROVE");
    expect(entry.task.name).toBe("Akceptacja przełożonego");
    expect(entry.document.status).toBe("IN_APPROVAL");
    expect(entry.document.tasks[0].name).toBe("Akceptacja finansowa");

    const finished = await anna.get("/documents?scope=involved&status=APPROVED,REJECTED,CANCELLED,ARCHIVED&limit=100");
    expect(finished.body.items.map((item: any) => item.id)).not.toContain(document.id);
  });

  it("zakończone obejmują tylko dokumenty, w których brałem udział", async () => {
    const document = await submittedInvoice(jan, "1000");
    const result = await decide(anna, await openTaskFor(anna, document.id), "APPROVE");
    expect(result.body.status).toBe("APPROVED");
    const statuses = "APPROVED,REJECTED,CANCELLED,ARCHIVED";
    const ids = async (client: Client) => (await client.get(`/documents?scope=involved&status=${statuses}&limit=100`)).body.items.map((item: any) => item.id);
    expect(await ids(jan)).toContain(document.id);
    expect(await ids(anna)).toContain(document.id);
    // Dyrektor widzi dokument z racji roli, ale nie brał w nim udziału.
    expect((await piotr.get(`/documents/${document.id}`)).status).toBe(200);
    expect(await ids(piotr)).not.toContain(document.id);
  });

  it("po przekazaniu zadania zachowuję wgląd w dokument, nad którym pracowałem", async () => {
    const document = await submittedInvoice(jan, "1000");
    const task = await openTaskFor(anna, document.id);
    const olgaId = await userId(emails.olga);
    await anna.post(`/workflow/tasks/${task.id}/delegate`, { delegateToUserId: olgaId, expectedVersion: task.version });
    expect((await anna.get(`/documents/${document.id}`)).status).toBe(200);
    const history = await anna.get("/workflow/actions/my?limit=100");
    expect(history.body.items.some((item: any) => item.document.id === document.id && item.actionType === "DELEGATE")).toBe(true);
  });
});
