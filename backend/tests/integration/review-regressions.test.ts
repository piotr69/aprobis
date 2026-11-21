import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileStorageRoot } from "../../src/config/env.js";
import { Client, decide, draftInvoice, emails, login, openTaskFor, prisma, startServer, submittedInvoice, typeId, userId, type TestServer } from "./helpers.js";

const DAY = 86_400_000;

function substitutionBody(substituteUserId: string) {
  return { substituteUserId, validFrom: new Date(Date.now() - 60_000).toISOString(), validTo: new Date(Date.now() + DAY).toISOString() };
}

describe("regresje z przeglądu backendu", () => {
  let server: TestServer;
  let jan: Client, anna: Client, ewa: Client, marek: Client, olga: Client, maria: Client, piotr: Client, tomasz: Client, karolina: Client, admin: Client, audytor: Client;

  beforeAll(async () => {
    server = await startServer();
    jan = await login(server.baseUrl, "jan");
    anna = await login(server.baseUrl, "anna");
    ewa = await login(server.baseUrl, "ewa");
    marek = await login(server.baseUrl, "marek");
    olga = await login(server.baseUrl, "olga");
    maria = await login(server.baseUrl, "maria");
    piotr = await login(server.baseUrl, "piotr");
    tomasz = await login(server.baseUrl, "tomasz");
    karolina = await login(server.baseUrl, "karolina");
    admin = await login(server.baseUrl, "admin");
    audytor = await login(server.baseUrl, "audytor");
  });

  afterAll(async () => { await server.close(); });

  /** Dokument autora w etapie roli BOARD: najpierw przechodzi przez przełożonego i księgowość. */
  async function ewaInvoiceAtBoardStage() {
    const document = await submittedInvoice(ewa, "60000");
    await decide(marek, await openTaskFor(marek, document.id), "APPROVE");
    await decide(maria, await openTaskFor(maria, document.id), "APPROVE");
    return document;
  }

  it("B01: zastępca autora nie zatwierdza dokumentu autora, a zastępca innego akceptującego tak", async () => {
    const document = await ewaInvoiceAtBoardStage();
    const task = await openTaskFor(marek, document.id);
    expect(task.name).toBe("Akceptacja zarządu");

    const ofAuthor = await ewa.post("/organization/substitutions", substitutionBody(await userId(emails.olga)));
    expect(ofAuthor.status).toBe(201);
    expect(await openTaskFor(olga, document.id)).toBeUndefined();
    expect((await decide(olga, task, "APPROVE")).status).toBe(403);
    await ewa.delete(`/organization/substitutions/${ofAuthor.body.id}`);

    const ofApprover = await marek.post("/organization/substitutions", substitutionBody(await userId(emails.olga)));
    expect((await openTaskFor(olga, document.id)).id).toBe(task.id);
    expect((await decide(olga, task, "APPROVE")).body.status).toBe("APPROVED");
    await marek.delete(`/organization/substitutions/${ofApprover.body.id}`);
  });

  it("B01: powiadomienie o zadaniu nie trafia do zastępcy autora", async () => {
    const substitution = await ewa.post("/organization/substitutions", substitutionBody(await userId(emails.piotr)));
    const document = await ewaInvoiceAtBoardStage();
    const notifications = await prisma.notification.count({ where: { documentId: document.id, userId: await userId(emails.piotr), type: "TASK_ASSIGNED" } });
    expect(notifications).toBe(0);
    await ewa.delete(`/organization/substitutions/${substitution.body.id}`);
  });

  it("B02: audytora ani administratora nie można uczynić akceptującym", async () => {
    const document = await submittedInvoice(jan, "1000");
    const task = await openTaskFor(anna, document.id);
    for (const email of [emails.audytor, emails.admin]) {
      const response = await admin.post(`/workflow/tasks/${task.id}/reassign`, { assignToUserId: await userId(email), comment: "Próba przepisania", expectedVersion: task.version });
      expect(response.status).toBe(400);
    }
    const delegated = await anna.post(`/workflow/tasks/${task.id}/delegate`, { delegateToUserId: await userId(emails.audytor), expectedVersion: task.version });
    expect(delegated.status).toBe(400);
    const substitute = await anna.post("/organization/substitutions", substitutionBody(await userId(emails.audytor)));
    expect(substitute.status).toBe(400);
  });

  it("B02: nawet wpisane wprost zadanie nie daje audytorowi decyzji ani komentarza", async () => {
    const document = await submittedInvoice(jan, "1000");
    const task = await openTaskFor(anna, document.id);
    await prisma.workflowTask.update({ where: { id: task.id }, data: { assignedToId: await userId(emails.audytor) } });
    expect((await decide(audytor, task, "APPROVE")).status).toBe(403);
    expect((await audytor.post(`/documents/${document.id}/comments`, { body: "Uwaga" })).status).toBe(403);
    await prisma.workflowTask.update({ where: { id: task.id }, data: { assignedToId: await userId(emails.anna) } });
  });

  it("B02: etap przypisany roli bez prawa decyzji idzie do przełożonego", async () => {
    const code = `AUD_${Date.now()}`;
    const type = await admin.post("/document-types", { name: code, code, category: "ADMIN" });
    await admin.post(`/document-types/${type.body.id}/versions/${type.body.draftVersion.id}/publish`);
    const saved = await admin.post("/rules/workflow-definitions", {
      name: "Etap audytora",
      documentTypeId: type.body.id,
      steps: [{ name: "Akceptacja audytora", stepType: "OPINION", order: 1, assigneeType: "ROLE", assigneeRole: "AUDITOR" }]
    });
    await admin.post(`/rules/workflow-definitions/${saved.body.id}/publish`);
    const document = await jan.post("/documents", { title: "Do audytora", typeId: type.body.id });
    const preview = await jan.get(`/documents/${document.body.id}/workflow-preview`);
    expect(preview.body.stages[0].approvers).toEqual(["Anna Kierownik"]);
  });

  it("B03: zastępca członka grupy widzi zadanie, które może wykonać", async () => {
    const group = await prisma.group.create({ data: { code: `G_${Date.now()}`, name: "Komisja", members: { create: { userId: await userId(emails.tomasz) } } } });
    const code = `GRUPA_${Date.now()}`;
    const type = await admin.post("/document-types", { name: code, code, category: "ADMIN" });
    await admin.post(`/document-types/${type.body.id}/versions/${type.body.draftVersion.id}/publish`);
    const saved = await admin.post("/rules/workflow-definitions", {
      name: "Etap grupy",
      documentTypeId: type.body.id,
      steps: [{ name: "Decyzja komisji", stepType: "OPINION", order: 1, assigneeType: "ROLE", assigneeRole: "BOARD", assignees: [{ assigneeType: "ROLE", groupId: group.id }] }]
    });
    expect(saved.status).toBe(201);
    await admin.post(`/rules/workflow-definitions/${saved.body.id}/publish`);
    const document = await jan.post("/documents", { title: "Do komisji", typeId: type.body.id });
    expect((await jan.post(`/documents/${document.body.id}/submit`)).status).toBe(201);

    const substitution = await tomasz.post("/organization/substitutions", substitutionBody(await userId(emails.olga)));
    const task = await openTaskFor(olga, document.body.id);
    expect(task).toBeTruthy();
    expect((await olga.get(`/documents/${document.body.id}`)).status).toBe(200);
    expect((await decide(olga, task, "APPROVE")).body.status).toBe("APPROVED");
    await tomasz.delete(`/organization/substitutions/${substitution.body.id}`);
  });

  it("B04: nieobsługiwana waluta jest odrzucana, a małe litery nie omijają reguł", async () => {
    const id = await typeId(jan, "FAKTURA_KOSZTOWA");
    const base = { title: "Faktura walutowa", typeId: id, amount: "100000", contractorName: "X", data: { invoiceNumber: "F/1", paymentDueAt: "2026-12-31" } };
    for (const currency of ["GBP", "CHF", "gbp"]) {
      expect((await jan.post("/documents", { ...base, currency })).status).toBe(400);
    }
    const lower = await jan.post("/documents", { ...base, currency: "eur" });
    expect(lower.status).toBe(201);
    expect(lower.body.currency).toBe("EUR");
    await jan.post(`/documents/${lower.body.id}/submit`);
    const detail = await jan.get(`/documents/${lower.body.id}`);
    expect(detail.body.workflowInstances[0].stages).toHaveLength(3);
  });

  it("B05: zmiana załączników podnosi wersję, a po złożeniu nie można ich usunąć", async () => {
    const document = await draftInvoice(jan, "100");
    const form = new FormData();
    form.append("file", new Blob(["treść"]), "a.txt");
    const uploaded = await jan.post(`/documents/${document.id}/files`, form);
    const after = await jan.get(`/documents/${document.id}`);
    expect(after.body.version).toBe(document.version + 1);

    expect((await jan.post(`/documents/${document.id}/submit`)).status).toBe(201);
    expect((await jan.delete(`/documents/${document.id}/files/${uploaded.body.id}`)).status).toBe(403);
    expect((await jan.get(`/documents/${document.id}/files`)).body).toHaveLength(1);
  });

  it("B06: wycofany szkic pozostaje prywatny, a wycofany złożony dokument widać dalej", async () => {
    const draft = await draftInvoice(jan, "100");
    expect((await maria.get(`/documents/${draft.id}`)).status).toBe(403);
    expect((await jan.post(`/documents/${draft.id}/cancel`, { expectedVersion: draft.version })).status).toBe(200);
    expect((await maria.get(`/documents/${draft.id}`)).status).toBe(403);
    expect((await anna.get(`/documents/${draft.id}`)).status).toBe(403);

    const submitted = await submittedInvoice(jan, "100");
    const detail = await jan.get(`/documents/${submitted.id}`);
    await jan.post(`/documents/${submitted.id}/cancel`, { expectedVersion: detail.body.version });
    expect((await maria.get(`/documents/${submitted.id}`)).status).toBe(200);
  });

  it("B07: edycja typu nie przepina ścieżki, a silnik nie użyje schematu innego typu", async () => {
    const definitions = await admin.get("/rules/workflow-definitions");
    const vacation = definitions.body.find((definition: any) => definition.name.startsWith("Wniosek urlopowy"));
    const invoiceTypeId = await typeId(jan, "FAKTURA_KOSZTOWA");
    const patched = await admin.patch(`/document-types/${invoiceTypeId}`, { defaultWorkflowId: vacation.id });
    expect(patched.status).toBe(200);
    expect(patched.body.defaultWorkflowId).toBeNull();

    await prisma.documentType.update({ where: { id: invoiceTypeId }, data: { defaultWorkflowId: vacation.id } });
    try {
      const document = await draftInvoice(jan, "60000");
      const preview = await jan.get(`/documents/${document.id}/workflow-preview`);
      expect(preview.body.stages.map((stage: any) => stage.name)).toEqual(["Akceptacja przełożonego", "Akceptacja finansowa", "Akceptacja zarządu"]);
    } finally {
      await prisma.documentType.update({ where: { id: invoiceTypeId }, data: { defaultWorkflowId: null } });
    }
  });

  it("B08: limity liczby, formatu i rozmiaru załączników działają, a zablokowany plik uniemożliwia złożenie", async () => {
    const code = `ZAL_${Date.now()}`;
    const type = await admin.post("/document-types", { name: code, code, category: "ADMIN" });
    await prisma.attachmentRequirement.create({
      data: { documentTypeVersionId: type.body.draftVersion.id, key: "skan", label: "Skan", minCount: 1, maxCount: 1, allowedMimeTypesJson: JSON.stringify(["application/pdf"]), maxSizeBytes: 100 }
    });
    await admin.post(`/document-types/${type.body.id}/versions/${type.body.draftVersion.id}/publish`);
    const document = await jan.post("/documents", { title: "Z limitami", typeId: type.body.id });
    const janId = await userId(emails.jan);
    const create = (name: string, mimeType: string, size: number, scanStatus: string, version: number) => prisma.documentFile.create({
      data: { documentId: document.body.id, version, originalName: name, storagePath: "brak", mimeType, size, scanStatus, uploadedById: janId }
    });

    const missing = await jan.post(`/documents/${document.body.id}/submit`);
    expect(missing.status).toBe(400);

    const png = await create("a.png", "image/png", 50, "CLEAN", 1);
    const wrongFormat = await jan.post(`/documents/${document.body.id}/submit`);
    expect(wrongFormat.body.details.issues[0].message).toContain("format");
    await prisma.documentFile.delete({ where: { id: png.id } });

    const big = await create("a.pdf", "application/pdf", 500, "CLEAN", 2);
    const tooBig = await jan.post(`/documents/${document.body.id}/submit`);
    expect(tooBig.body.details.issues[0].message).toContain("za duży");
    await prisma.documentFile.delete({ where: { id: big.id } });

    await create("b.pdf", "application/pdf", 50, "CLEAN", 3);
    const second = await create("c.pdf", "application/pdf", 50, "CLEAN", 4);
    const tooMany = await jan.post(`/documents/${document.body.id}/submit`);
    expect(tooMany.body.details.issues[0].message).toContain("najwyżej");
    await prisma.documentFile.delete({ where: { id: second.id } });

    const infected = await create("wirus.pdf", "application/pdf", 50, "REJECTED", 5);
    const blocked = await jan.post(`/documents/${document.body.id}/submit`);
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toContain("Antywirus");
    await prisma.documentFile.delete({ where: { id: infected.id } });

    expect((await jan.post(`/documents/${document.body.id}/submit`)).status).toBe(201);
  });

  it("zastępstwo działa tylko w swoim czasie", async () => {
    const document = await submittedInvoice(jan, "1000");
    const task = await openTaskFor(anna, document.id);
    const substitution = await anna.post("/organization/substitutions", substitutionBody(await userId(emails.olga)));

    await prisma.userSubstitution.update({ where: { id: substitution.body.id }, data: { validFrom: new Date(Date.now() - 2 * DAY), validTo: new Date(Date.now() - DAY) } });
    expect(await openTaskFor(olga, document.id)).toBeUndefined();
    expect((await decide(olga, task, "APPROVE")).status).toBe(403);

    await prisma.userSubstitution.update({ where: { id: substitution.body.id }, data: { validFrom: new Date(Date.now() + DAY), validTo: new Date(Date.now() + 2 * DAY) } });
    expect(await openTaskFor(olga, document.id)).toBeUndefined();
    await anna.delete(`/organization/substitutions/${substitution.body.id}`);
  });

  it("wniosek urlopowy kierownika przechodzi oba etapy do końca", async () => {
    const created = await anna.post("/documents", {
      title: "Urlop do końca",
      typeId: await typeId(anna, "WNIOSEK_URLOPOWY"),
      data: { vacationKind: "Wypoczynkowy", vacationStart: "2026-12-01", vacationEnd: "2026-12-05", vacationDays: "5", substitute: "Jan" }
    });
    await anna.post(`/documents/${created.body.id}/submit`);
    expect((await decide(piotr, await openTaskFor(piotr, created.body.id), "APPROVE")).body.status).toBe("NEXT_STAGE_OPENED");
    expect((await decide(karolina, await openTaskFor(karolina, created.body.id), "APPROVE")).body.status).toBe("APPROVED");
  });

  it("odrzucony plik nie zostaje na dysku", async () => {
    const before = fs.readdirSync(fileStorageRoot).length;
    const document = await draftInvoice(jan, "100");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([0x4d, 0x5a, 0x90, 0x00])]), "program.exe");
    expect((await jan.post(`/documents/${document.id}/files`, form)).status).toBe(415);
    expect(fs.readdirSync(fileStorageRoot).length).toBe(before);
  });

  it("paginacja zwraca kolejne strony bez powtórzeń", async () => {
    await draftInvoice(jan, "1");
    await draftInvoice(jan, "2");
    await draftInvoice(jan, "3");
    const first = await jan.get("/documents?scope=created-by-me&limit=2");
    expect(first.body.pageInfo.hasNextPage).toBe(true);
    const second = await jan.get(`/documents?scope=created-by-me&limit=2&cursor=${first.body.pageInfo.nextCursor}`);
    const ids = [...first.body.items, ...second.body.items].map((item: any) => item.id);
    expect(new Set(ids).size).toBe(4);
  });
});

describe("etapy z wieloma osobami i etapy równoległe", () => {
  let server: TestServer;
  let jan: Client, admin: Client, piotr: Client, maria: Client, tomasz: Client;

  beforeAll(async () => {
    server = await startServer();
    jan = await login(server.baseUrl, "jan");
    admin = await login(server.baseUrl, "admin");
    piotr = await login(server.baseUrl, "piotr");
    maria = await login(server.baseUrl, "maria");
    tomasz = await login(server.baseUrl, "tomasz");
  });

  afterAll(async () => { await server.close(); });

  async function documentWithStep(step: Record<string, unknown>, extraSteps: Array<Record<string, unknown>> = []) {
    const code = `WIELU_${Date.now()}_${Math.round(Math.random() * 1000)}`;
    const type = await admin.post("/document-types", { name: code, code, category: "ADMIN" });
    await admin.post(`/document-types/${type.body.id}/versions/${type.body.draftVersion.id}/publish`);
    const saved = await admin.post("/rules/workflow-definitions", {
      name: "Wiele osób",
      documentTypeId: type.body.id,
      steps: [{ name: "Etap", stepType: "OPINION", order: 1, stageNo: 1, assigneeType: "USER", assigneeUserId: await userId(emails.piotr), ...step }, ...extraSteps]
    });
    expect(saved.status).toBe(201);
    await admin.post(`/rules/workflow-definitions/${saved.body.id}/publish`);
    const document = await jan.post("/documents", { title: "Dokument wieloosobowy", typeId: type.body.id });
    expect((await jan.post(`/documents/${document.body.id}/submit`)).status).toBe(201);
    return document.body.id as string;
  }

  const assignee = async (email: string) => ({ assigneeType: "USER", userId: await userId(email) });

  it("ALL czeka na wszystkich", async () => {
    const id = await documentWithStep({ completionMode: "ALL", assignees: [await assignee(emails.piotr), await assignee(emails.maria)] });
    expect((await decide(piotr, await openTaskFor(piotr, id), "APPROVE")).body.status).toBe("STAGE_IN_PROGRESS");
    expect((await decide(maria, await openTaskFor(maria, id), "APPROVE")).body.status).toBe("APPROVED");
  });

  it("ANY kończy się po pierwszej decyzji, a zadanie drugiej osoby znika", async () => {
    const id = await documentWithStep({ completionMode: "ANY", assignees: [await assignee(emails.piotr), await assignee(emails.maria)] });
    expect((await decide(piotr, await openTaskFor(piotr, id), "APPROVE")).body.status).toBe("APPROVED");
    expect(await openTaskFor(maria, id)).toBeUndefined();
  });

  it("QUORUM wymaga ustalonej liczby decyzji", async () => {
    const id = await documentWithStep({
      completionMode: "QUORUM",
      requiredApprovals: 2,
      assignees: [await assignee(emails.piotr), await assignee(emails.maria), await assignee(emails.tomasz)]
    });
    expect((await decide(piotr, await openTaskFor(piotr, id), "APPROVE")).body.status).toBe("STAGE_IN_PROGRESS");
    expect((await decide(tomasz, await openTaskFor(tomasz, id), "APPROVE")).body.status).toBe("APPROVED");
    expect(await openTaskFor(maria, id)).toBeUndefined();
  });

  it("odrzucenie przez jedną osobę kończy etap z wieloma osobami", async () => {
    const id = await documentWithStep({ completionMode: "ALL", assignees: [await assignee(emails.piotr), await assignee(emails.maria)] });
    await decide(piotr, await openTaskFor(piotr, id), "APPROVE");
    expect((await decide(maria, await openTaskFor(maria, id), "REJECT", "Nie")).body.status).toBe("REJECTED");
  });

  it("równoległe decyzje dwóch osób w jednym etapie nie gubią zakończenia", async () => {
    const id = await documentWithStep({ completionMode: "ALL", assignees: [await assignee(emails.piotr), await assignee(emails.maria)] });
    const results = await Promise.all([
      decide(piotr, await openTaskFor(piotr, id), "APPROVE"),
      decide(maria, await openTaskFor(maria, id), "APPROVE")
    ]);
    const succeeded = results.filter((result) => result.status === 200);
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    for (const [index, result] of results.entries()) {
      if (result.status !== 200) {
        const client = index === 0 ? piotr : maria;
        expect((await decide(client, await openTaskFor(client, id), "APPROVE")).status).toBe(200);
      }
    }
    expect((await jan.get(`/documents/${id}`)).body.status).toBe("APPROVED");
  });

  it("etapy równoległe: następny otwiera się dopiero po obu", async () => {
    const id = await documentWithStep(
      { stageNo: 1, parallelGroup: 1, assigneeUserId: await userId(emails.piotr) },
      [
        { name: "Równoległy", stepType: "OPINION", order: 2, stageNo: 1, parallelGroup: 2, assigneeType: "USER", assigneeUserId: await userId(emails.maria) },
        { name: "Końcowy", stepType: "OPINION", order: 3, stageNo: 2, parallelGroup: 1, assigneeType: "USER", assigneeUserId: await userId(emails.tomasz) }
      ]
    );
    expect(await openTaskFor(tomasz, id)).toBeUndefined();
    await decide(piotr, await openTaskFor(piotr, id), "APPROVE");
    expect(await openTaskFor(tomasz, id)).toBeUndefined();
    expect((await decide(maria, await openTaskFor(maria, id), "APPROVE")).body.status).toBe("NEXT_STAGE_OPENED");
    expect((await decide(tomasz, await openTaskFor(tomasz, id), "APPROVE")).body.status).toBe("APPROVED");
  });
});

describe("regresje z przeglądu końcowego", () => {
  let server: TestServer;
  let jan: Client, anna: Client, olga: Client, admin: Client;

  beforeAll(async () => {
    server = await startServer();
    jan = await login(server.baseUrl, "jan");
    anna = await login(server.baseUrl, "anna");
    olga = await login(server.baseUrl, "olga");
    admin = await login(server.baseUrl, "admin");
  });

  afterAll(async () => { await server.close(); });

  async function withRole<T>(email: string, role: string, work: () => Promise<T>) {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true, role: true } });
    await prisma.user.update({ where: { id: user.id }, data: { role } });
    try {
      return await work();
    } finally {
      await prisma.user.update({ where: { id: user.id }, data: { role: user.role } });
    }
  }

  it("F01: autor po zmianie roli na tylko do odczytu widzi, ale nie zmienia swojego dokumentu", async () => {
    const draft = await draftInvoice(jan, "100");
    await withRole(emails.jan, "AUDITOR", async () => {
      const detail = await jan.get(`/documents/${draft.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.actionsAllowed).toMatchObject({ canEdit: false, canSubmit: false, canUpload: false, canComment: false, canCancel: false });
      expect((await jan.patch(`/documents/${draft.id}`, { expectedVersion: draft.version, title: "Zmiana audytora" })).status).toBe(403);
      expect((await jan.post(`/documents/${draft.id}/submit`)).status).toBe(403);
      expect((await jan.post(`/documents/${draft.id}/cancel`, { expectedVersion: draft.version })).status).toBe(403);
      expect((await jan.post(`/documents/${draft.id}/comments`, { body: "Uwaga" })).status).toBe(403);
    });
    expect((await jan.post(`/documents/${draft.id}/submit`)).status).toBe(201);
  });

  it("F02: odebranie prawa decyzji zastępowanemu odbiera je też zastępcy", async () => {
    const document = await submittedInvoice(jan, "1000");
    const task = await openTaskFor(anna, document.id);
    const substitution = await anna.post("/organization/substitutions", substitutionBody(await userId(emails.olga)));
    expect((await openTaskFor(olga, document.id)).id).toBe(task.id);
    await withRole(emails.anna, "AUDITOR", async () => {
      expect(await openTaskFor(olga, document.id)).toBeUndefined();
      expect((await decide(olga, task, "APPROVE")).status).toBe(403);
      expect((await olga.get("/auth/me")).body.actingFor).toEqual([]);
    });
    await anna.delete(`/organization/substitutions/${substitution.body.id}`);
  });

  it("F04: dokument trzyma szablon tytułu swojej wersji formularza", async () => {
    const code = `TYTUL_${Date.now()}`;
    const created = await admin.post("/document-types", {
      name: code, code, category: "ADMIN", titleTemplate: "Stary {stare}",
      fields: [{ key: "stare", label: "Stare", type: "text" }]
    });
    await admin.post(`/document-types/${created.body.id}/versions/${created.body.draftVersion.id}/publish`);
    const document = await jan.post("/documents", { title: "Stary wartość", typeId: created.body.id, data: { stare: "wartość" } });
    const patched = await admin.patch(`/document-types/${created.body.id}`, { titleTemplate: "Nowy {nowe}", fields: [{ key: "nowe", label: "Nowe", type: "text" }] });
    await admin.post(`/document-types/${created.body.id}/versions/${patched.body.draftVersion.id}/publish`);
    const detail = await jan.get(`/documents/${document.body.id}`);
    expect(detail.body.formTitleTemplate).toBe("Stary {stare}");
    expect(detail.body.formFields.map((field: any) => field.key)).toEqual(["stare"]);
    expect(detail.body.title).toBe("Stary wartość");
  });

  it("R01: wyłączenie szablonu działa w nowej wersji, a stara zachowuje swój", async () => {
    const code = `BEZSZABLONU_${Date.now()}`;
    const fields = [{ key: "kod", label: "Kod", type: "text" }];
    const created = await admin.post("/document-types", { name: code, code, category: "ADMIN", titleTemplate: "Auto {kod}", fields });
    await admin.post(`/document-types/${created.body.id}/versions/${created.body.draftVersion.id}/publish`);
    const onV1 = await jan.post("/documents", { title: "Auto 123", typeId: created.body.id, data: { kod: "123" } });

    const patched = await admin.patch(`/document-types/${created.body.id}`, { titleTemplate: null, fields });
    await admin.post(`/document-types/${created.body.id}/versions/${patched.body.draftVersion.id}/publish`);
    const onV2 = await jan.post("/documents", { title: "Tytuł wpisany ręcznie", typeId: created.body.id, data: { kod: "456" } });

    expect((await jan.get(`/documents/${onV1.body.id}`)).body.formTitleTemplate).toBe("Auto {kod}");
    const detail = await jan.get(`/documents/${onV2.body.id}`);
    expect(detail.body.formTitleTemplate).toBeNull();
    const edited = await jan.patch(`/documents/${onV2.body.id}`, { expectedVersion: detail.body.version, title: detail.body.title, data: { kod: "789" } });
    expect(edited.body.title).toBe("Tytuł wpisany ręcznie");

    // Zmiana samych pól bez podania szablonu go nie kasuje.
    const withTemplate = await admin.patch(`/document-types/${created.body.id}`, { titleTemplate: "Znów {kod}", fields });
    await admin.post(`/document-types/${created.body.id}/versions/${withTemplate.body.draftVersion.id}/publish`);
    const fieldsOnly = await admin.patch(`/document-types/${created.body.id}`, { fields });
    expect(fieldsOnly.body.draftVersion.titleTemplate).toBe("Znów {kod}");
  });

  it("F05: lista podaje łączną liczbę także poza pierwszą stroną", async () => {
    await draftInvoice(olga, "1");
    await draftInvoice(olga, "2");
    const page = await olga.get("/documents?scope=created-by-me&status=DRAFT&limit=1");
    expect(page.body.items).toHaveLength(1);
    expect(page.body.pageInfo.total).toBeGreaterThanOrEqual(2);
    expect(page.body.pageInfo.hasNextPage).toBe(true);
  });

  it("F07: nie można opublikować wymagania załącznika w fazie, której system nie sprawdza", async () => {
    const code = `FAZA_${Date.now()}`;
    const created = await admin.post("/document-types", { name: code, code, category: "ADMIN" });
    await prisma.attachmentRequirement.create({ data: { documentTypeVersionId: created.body.draftVersion.id, key: "skan", label: "Skan", status: "DRAFT", minCount: 1 } });
    const published = await admin.post(`/document-types/${created.body.id}/versions/${created.body.draftVersion.id}/publish`);
    expect(published.status).toBe(400);
  });
});
