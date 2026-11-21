import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, decide, emails, login, openTaskFor, prisma, startServer, userId, type TestServer } from "./helpers.js";

/** Stałe schematy z wybranymi osobami (krok A propozycji „schematy-akceptacji”). */
describe("schematy typów i wybrane osoby", () => {
  let server: TestServer;
  let admin: Client, jan: Client, anna: Client, karolina: Client, maria: Client;

  beforeAll(async () => {
    server = await startServer();
    admin = await login(server.baseUrl, "admin");
    jan = await login(server.baseUrl, "jan");
    anna = await login(server.baseUrl, "anna");
    karolina = await login(server.baseUrl, "karolina");
    maria = await login(server.baseUrl, "maria");
  });

  afterAll(async () => { await server.close(); });

  async function newType() {
    const code = `SCHEMAT_${Date.now()}_${Math.round(Math.random() * 1000)}`;
    const type = await admin.post("/document-types", { name: code, code, category: "HR" });
    expect(type.status).toBe(201);
    await admin.post(`/document-types/${type.body.id}/versions/${type.body.draftVersion.id}/publish`);
    return type.body.id as string;
  }

  const people = async (...list: string[]) => Promise.all(list.map(async (email) => ({ assigneeType: "USER", userId: await userId(email) })));

  async function publishSchema(typeId: string, steps: Array<Record<string, unknown>>) {
    const saved = await admin.post("/rules/workflow-definitions", { name: "Schemat testowy", documentTypeId: typeId, steps });
    expect(saved.status).toBe(201);
    const published = await admin.post(`/rules/workflow-definitions/${saved.body.id}/publish`);
    return { id: saved.body.id as string, published };
  }

  const peopleStep = async (name: string, list: string[], completionMode = "ALL") =>
    ({ name, stepType: "BUSINESS_APPROVAL", order: 1, assigneeType: "USER", completionMode, assignees: await people(...list) });

  async function submitAsJan(typeId: string) {
    const document = await jan.post("/documents", { title: "Wniosek testowy", typeId });
    expect(document.status).toBe(201);
    const submitted = await jan.post(`/documents/${document.body.id}/submit`);
    return { id: document.body.id as string, submitted };
  }

  it("przegląd pokazuje wbudowaną ścieżkę, a po publikacji schemat z osobami", async () => {
    const typeId = await newType();
    let overview = await admin.get("/rules/workflow-overview");
    expect(overview.status).toBe(200);
    // Baza testowa ma reguły z danych przykładowych, więc bez schematu typ idzie regułami albo wbudowaną ścieżką.
    expect(["DEFAULT", "RULES"]).toContain(overview.body.find((item: any) => item.type.id === typeId).source);

    const { published } = await publishSchema(typeId, [
      { name: "Przełożony", stepType: "MANAGER_APPROVAL", order: 1, assigneeType: "MANAGER" },
      { ...(await peopleStep("Kadry", [emails.karolina, emails.maria], "ANY")), order: 2 }
    ]);
    expect(published.status).toBe(200);
    overview = await admin.get("/rules/workflow-overview");
    const item = overview.body.find((entry: any) => entry.type.id === typeId);
    expect(item.source).toBe("SCHEMA");
    expect(item.definition.isAdvanced).toBe(false);
    expect(item.definition.steps.map((step: any) => step.name)).toEqual(["Przełożony", "Kadry"]);
    expect(item.definition.steps[1]).toMatchObject({ completionMode: "ANY", people: ["Karolina HR", "Maria Księgowość"] });
  });

  it("przegląd wymaga uprawnienia do konfiguracji obiegów", async () => {
    expect((await jan.get("/rules/workflow-overview")).status).toBe(403);
  });

  it("lista osób wraca z API w tej samej postaci (round-trip edytora)", async () => {
    const typeId = await newType();
    const { id } = await publishSchema(typeId, [await peopleStep("Kadry", [emails.karolina, emails.maria], "ANY")]);
    const list = await admin.get(`/rules/workflow-definitions?documentTypeId=${typeId}`);
    const definition = list.body.find((item: any) => item.id === id);
    expect(definition.isAdvanced).toBe(false);
    expect(definition.steps[0].completionMode).toBe("ANY");
    expect(definition.steps[0].assignees.map((assignee: any) => assignee.userId)).toEqual([await userId(emails.karolina), await userId(emails.maria)]);
  });

  it("ta sama osoba dwa razy w etapie to błąd zapisu", async () => {
    const typeId = await newType();
    const saved = await admin.post("/rules/workflow-definitions", {
      name: "Duplikat",
      documentTypeId: typeId,
      steps: [await peopleStep("Kadry", [emails.karolina, emails.karolina])]
    });
    expect(saved.status).toBe(400);
  });

  it("publikacja odrzuca osobę bez prawa decyzji i konto nieaktywne", async () => {
    const typeId = await newType();
    const saved = await admin.post("/rules/workflow-definitions", { name: "Audytor", documentTypeId: typeId, steps: [await peopleStep("Kontrola", [emails.audytor])] });
    expect(saved.status).toBe(201);
    const published = await admin.post(`/rules/workflow-definitions/${saved.body.id}/publish`);
    expect(published.status).toBe(400);
    expect(published.body.message).toContain("bez prawa decyzji");
  });

  it("autor na liście jest pomijany, decydują pozostali", async () => {
    const typeId = await newType();
    await publishSchema(typeId, [await peopleStep("Kadry", [emails.jan, emails.karolina])]);
    const { id, submitted } = await submitAsJan(typeId);
    expect(submitted.status).toBe(201);
    expect(await openTaskFor(jan, id)).toBeUndefined();
    expect((await decide(karolina, await openTaskFor(karolina, id), "APPROVE")).body.status).toBe("APPROVED");
  });

  it("autor jedyny na liście: etap przejmuje jego przełożony, a podgląd to mówi", async () => {
    const typeId = await newType();
    await publishSchema(typeId, [await peopleStep("Kadry", [emails.jan])]);
    const document = await jan.post("/documents", { title: "Wniosek testowy", typeId });
    const preview = await jan.get(`/documents/${document.body.id}/workflow-preview`);
    expect(preview.body.stages[0]).toMatchObject({ authorReplaced: true, approvers: ["Anna Kierownik"] });
    expect((await jan.post(`/documents/${document.body.id}/submit`)).status).toBe(201);

    // Po złożeniu powód zostaje w historii obiegu i w audycie, także po publikacji kolejnej wersji schematu.
    await publishSchema(typeId, [{ name: "Przełożony", stepType: "MANAGER_APPROVAL", order: 1, assigneeType: "MANAGER" }]);
    const detail = await jan.get(`/documents/${document.body.id}`);
    const stage = detail.body.workflowInstances[0].stages[0];
    expect(JSON.parse(stage.configSnapshotJson).authorReplaced).toBe(true);
    const started = await prisma.auditLog.findFirst({ where: { entityId: document.body.id, action: "WORKFLOW_STARTED" } });
    expect(JSON.parse(started!.afterJson!).authorReplacedStages).toEqual(["Kadry"]);

    expect((await decide(anna, await openTaskFor(anna, document.body.id), "APPROVE")).body.status).toBe("APPROVED");
  });

  it("osoba z jednoczesną grupą, rolą lub działem to błąd zapisu (silnik wybrałby grupę)", async () => {
    const typeId = await newType();
    const group = await prisma.group.findFirst();
    const saved = await admin.post("/rules/workflow-definitions", {
      name: "Mieszane",
      documentTypeId: typeId,
      steps: [{ name: "Kadry", stepType: "BUSINESS_APPROVAL", order: 1, assigneeType: "USER", assignees: [{ assigneeType: "USER", userId: await userId(emails.karolina), groupId: group?.id ?? "grupa" }] }]
    });
    expect(saved.status).toBe(400);
  });

  it("po wykluczeniu autora ta sama osoba nie dostaje dwóch zadań", async () => {
    const typeId = await newType();
    await publishSchema(typeId, [await peopleStep("Decyzja", [emails.jan, emails.anna])]);
    const { id } = await submitAsJan(typeId);
    const tasks = await prisma.workflowTask.findMany({ where: { documentId: id } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assignedToId).toBe(await userId(emails.anna));
  });

  it("wybrana osoba, która straciła możliwość decyzji, blokuje złożenie czytelnym 422 zamiast cichego zastępstwa", async () => {
    const typeId = await newType();
    await publishSchema(typeId, [await peopleStep("Kadry", [emails.karolina, emails.maria])]);
    const mariaId = await userId(emails.maria);
    await prisma.user.update({ where: { id: mariaId }, data: { isActive: false } });
    try {
      const { submitted } = await submitAsJan(typeId);
      expect(submitted.status).toBe(422);
      expect(submitted.body.message).toContain("Maria Księgowość");
      expect(submitted.body.message).toContain("nieaktywne");
    } finally {
      await prisma.user.update({ where: { id: mariaId }, data: { isActive: true } });
    }
  });

  it("ALL czeka na wszystkie wybrane osoby poza autorem", async () => {
    const typeId = await newType();
    await publishSchema(typeId, [await peopleStep("Kadry", [emails.jan, emails.karolina, emails.maria])]);
    const { id } = await submitAsJan(typeId);
    expect((await decide(karolina, await openTaskFor(karolina, id), "APPROVE")).body.status).toBe("STAGE_IN_PROGRESS");
    expect((await decide(maria, await openTaskFor(maria, id), "APPROVE")).body.status).toBe("APPROVED");
  });
});
