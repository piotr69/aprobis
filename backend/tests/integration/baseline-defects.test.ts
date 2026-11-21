import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decide, draftInvoice, login, openTaskFor, prisma, startServer, submittedInvoice, typeId, type Client, type TestServer } from "./helpers.js";

/** Regresje błędów znalezionych w audycie: każdy z tych testów był czerwony przed naprawą. */
describe("błędy obiegu i uprawnień", () => {
  let server: TestServer;
  let jan: Client, anna: Client, olga: Client, piotr: Client, maria: Client;

  beforeAll(async () => {
    server = await startServer();
    jan = await login(server.baseUrl, "jan");
    anna = await login(server.baseUrl, "anna");
    olga = await login(server.baseUrl, "olga");
    piotr = await login(server.baseUrl, "piotr");
    maria = await login(server.baseUrl, "maria");
  });

  afterAll(async () => { await server.close(); });

  it("obcy pracownik nie otworzy cudzego dokumentu po identyfikatorze", async () => {
    const document = await submittedInvoice(jan, "1000");
    for (const path of ["", "/files", "/workflow-preview"]) {
      expect((await olga.get(`/documents/${document.id}${path}`)).status).toBe(403);
    }
  });

  it("autor nie zatwierdzi własnego dokumentu po zwrocie do korekty", async () => {
    const document = await submittedInvoice(jan, "1000");
    const managerTask = await openTaskFor(anna, document.id);
    expect((await decide(anna, managerTask, "RETURN", "Brak opisu")).status).toBe(200);

    expect(await openTaskFor(jan, document.id)).toBeUndefined();
    const retried = await anna.post(`/workflow/tasks/${managerTask.id}/decision`, { decision: "APPROVE", expectedVersion: managerTask.version + 1 });
    expect(retried.status).toBe(409);
    const after = await jan.get(`/documents/${document.id}`);
    expect(after.body.status).toBe("NEEDS_CORRECTION");
  });

  it("wniosek urlopowy kierownika da się zatwierdzić do końca", async () => {
    const created = await anna.post("/documents", {
      title: "Urlop kierownika",
      typeId: await typeId(anna, "WNIOSEK_URLOPOWY"),
      data: { vacationKind: "Wypoczynkowy", vacationStart: "2026-12-01", vacationEnd: "2026-12-05", vacationDays: "5", substitute: "Jan" }
    });
    expect(created.status).toBe(201);
    expect((await anna.post(`/documents/${created.body.id}/submit`)).status).toBe(201);
    const task = await openTaskFor(piotr, created.body.id);
    expect((await decide(piotr, task, "APPROVE")).status).toBe(200);
  });

  it("faktura w EUR o wysokiej kwocie nie omija akceptacji finansowej i zarządu", async () => {
    const document = await submittedInvoice(jan, "100000", "EUR");
    const detail = await jan.get(`/documents/${document.id}`);
    const stages: string[] = detail.body.workflowInstances[0].stages.map((stage: any) => stage.name);
    expect(stages).toEqual(["Akceptacja przełożonego", "Akceptacja finansowa", "Akceptacja zarządu"]);
  });

  it("autor nie wybierze sobie działu, żeby trafić do łagodniejszego akceptującego", async () => {
    const departments = await jan.get("/organization/departments");
    const foreign = departments.body.find((department: any) => department.code === "FIN");
    const created = await jan.post("/documents", {
      title: "Faktura z obcym działem",
      typeId: await typeId(jan, "FAKTURA_KOSZTOWA"),
      amount: "100",
      contractorName: "X",
      departmentId: foreign.id,
      data: { invoiceNumber: "FV/2", paymentDueAt: "2026-12-31" }
    });
    expect(created.status).toBe(201);
    const detail = await jan.get(`/documents/${created.body.id}`);
    expect(detail.body.department.code).toBe("PROD");
  });

  it("zwrot i odrzucenie wymagają uzasadnienia również na poziomie API", async () => {
    const document = await submittedInvoice(jan, "1000");
    const task = await openTaskFor(anna, document.id);
    expect((await decide(anna, task, "REJECT")).status).toBe(400);
    expect((await decide(anna, task, "RETURN", "   ")).status).toBe(400);
  });

  it("autor może wycofać dokument będący w akceptacji, a zadania znikają", async () => {
    const document = await submittedInvoice(jan, "1000");
    const detail = await jan.get(`/documents/${document.id}`);
    const response = await jan.post(`/documents/${document.id}/cancel`, { expectedVersion: detail.body.version });
    expect(response.status).toBe(200);
    expect(await openTaskFor(anna, document.id)).toBeUndefined();
    const stages = await prisma.workflowInstanceStage.findMany({ where: { instance: { documentId: document.id }, status: { in: ["OPEN", "PENDING"] } } });
    expect(stages).toHaveLength(0);
  });

  it("autor dostaje powiadomienie o decyzji, a osoby z roli o nowym zadaniu", async () => {
    const document = await submittedInvoice(jan, "60000");
    const managerTask = await openTaskFor(anna, document.id);
    await decide(anna, managerTask, "APPROVE");

    const accountingNotifications = await maria.get("/notifications");
    expect(accountingNotifications.body.items.some((item: any) => item.documentId === document.id)).toBe(true);

    const accountingTask = await openTaskFor(maria, document.id);
    await decide(maria, accountingTask, "REJECT", "Błędna kwota");
    const authorNotifications = await jan.get("/notifications");
    const rejected = authorNotifications.body.items.find((item: any) => item.documentId === document.id && item.type === "DOCUMENT_REJECTED");
    expect(rejected.body).toContain("Błędna kwota");
  });

  it("kolejny etap dostaje termin dopiero przy otwarciu", async () => {
    const document = await submittedInvoice(jan, "60000");
    const pending = await prisma.workflowTask.findMany({ where: { documentId: document.id, status: "PENDING" } });
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((task) => task.dueAt === null)).toBe(true);

    const managerTask = await openTaskFor(anna, document.id);
    await decide(anna, managerTask, "APPROVE");
    const accountingTask = await openTaskFor(maria, document.id);
    const daysLeft = (new Date(accountingTask.dueAt).getTime() - Date.now()) / 86_400_000;
    expect(daysLeft).toBeGreaterThan(1.9);
  });

  it("notatka wewnętrzna nie wycieka do autora przez żaden endpoint", async () => {
    const document = await submittedInvoice(jan, "1000");
    const task = await openTaskFor(anna, document.id);
    const secret = "POUFNA-NOTATKA-KIEROWNIKA";
    expect((await anna.post(`/documents/${document.id}/comments`, { body: secret, visibility: "INTERNAL", taskId: task.id })).status).toBe(201);
    expect(JSON.stringify((await anna.get(`/documents/${document.id}`)).body)).toContain(secret);
    expect(JSON.stringify((await jan.get(`/documents/${document.id}`)).body)).not.toContain(secret);
    expect(JSON.stringify((await jan.get(`/workflow/tasks/${task.id}`)).body)).not.toContain(secret);
  });

  it("zmiana kwoty po wczytaniu planu nie przechodzi po cichu przez obieg ze starej kwoty", async () => {
    // Dokument w korekcie: po zmianie kwoty ponowne złożenie liczy ścieżkę od nowa.
    const document = await submittedInvoice(jan, "1000");
    const task = await openTaskFor(anna, document.id);
    await decide(anna, task, "RETURN", "Zła kwota");
    const before = await jan.get(`/documents/${document.id}`);
    const patched = await jan.patch(`/documents/${document.id}`, { expectedVersion: before.body.version, amount: "60000" });
    expect(patched.status).toBe(200);
    expect((await jan.post(`/documents/${document.id}/submit`)).status).toBe(201);
    const detail = await jan.get(`/documents/${document.id}`);
    expect(detail.body.workflowInstances[0].stages.map((stage: any) => stage.name)).toEqual([
      "Akceptacja przełożonego", "Akceptacja finansowa", "Akceptacja zarządu"
    ]);
  });

  it("nie przyjmuje niepoprawnej kwoty ani nieistniejącego centrum kosztów jako błędu serwera", async () => {
    const id = await typeId(jan, "FAKTURA_KOSZTOWA");
    const badAmount = await jan.post("/documents", { title: "Zła kwota", typeId: id, amount: "abc" });
    expect(badAmount.status).toBe(400);
    const badCostCenter = await jan.post("/documents", { title: "Złe MPK", typeId: id, costCenterId: "nie-istnieje" });
    expect(badCostCenter.status).toBe(400);
    const draft = await draftInvoice(jan, "10");
    expect(draft.number).toMatch(/^DMS\//);
  });
});
