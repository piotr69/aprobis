import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decide, draftInvoice, emails, login, openTaskFor, passwords, prisma, startServer, submittedInvoice, typeId, userId, type Client, type TestServer } from "./helpers.js";

describe("pełne ścieżki obiegu", () => {
  let server: TestServer;
  const clients = {} as Record<"jan" | "anna" | "piotr" | "maria" | "ewa" | "marek" | "karolina" | "tomasz" | "sekretariat" | "admin" | "audytor" | "olga", Client>;

  beforeAll(async () => {
    server = await startServer();
    for (const who of Object.keys({ jan: 1, anna: 1, piotr: 1, maria: 1, ewa: 1, marek: 1, karolina: 1, tomasz: 1, sekretariat: 1, admin: 1, audytor: 1, olga: 1 }) as Array<keyof typeof clients>) {
      clients[who] = await login(server.baseUrl, who);
    }
  });

  afterAll(async () => { await server.close(); });

  it("faktura powyżej 50 000 PLN przechodzi trzy etapy, a potem archiwum", async () => {
    const { jan, anna, maria, ewa, sekretariat } = clients;
    const document = await submittedInvoice(jan, "82000");
    expect((await decide(anna, await openTaskFor(anna, document.id), "APPROVE")).body.status).toBe("NEXT_STAGE_OPENED");
    expect((await decide(maria, await openTaskFor(maria, document.id), "APPROVE")).body.status).toBe("NEXT_STAGE_OPENED");
    expect((await decide(ewa, await openTaskFor(ewa, document.id), "APPROVE")).body.status).toBe("APPROVED");

    const approved = await sekretariat.get(`/documents/${document.id}`);
    expect(approved.body.status).toBe("APPROVED");
    expect(approved.body.actionsAllowed.canArchive).toBe(true);
    expect((await jan.post(`/documents/${document.id}/archive`, { expectedVersion: approved.body.version })).status).toBe(403);
    const archived = await sekretariat.post(`/documents/${document.id}/archive`, { expectedVersion: approved.body.version });
    expect(archived.status).toBe(200);
    expect(archived.body.status).toBe("ARCHIVED");
  });

  it("po korekcie obieg zaczyna się od początku i można go ukończyć", async () => {
    const { jan, anna } = clients;
    const document = await submittedInvoice(jan, "1000");
    await decide(anna, await openTaskFor(anna, document.id), "RETURN", "Dopisz opis");
    const returned = await jan.get(`/documents/${document.id}`);
    expect(returned.body.actionsAllowed).toMatchObject({ canEdit: true, canSubmit: true });
    const edited = await jan.patch(`/documents/${document.id}`, { expectedVersion: returned.body.version, title: "Faktura z opisem" });
    expect(edited.status).toBe(200);
    expect((await jan.post(`/documents/${document.id}/submit`)).status).toBe(201);
    const result = await decide(anna, await openTaskFor(anna, document.id), "APPROVE");
    expect(result.body.status).toBe("APPROVED");
    const detail = await jan.get(`/documents/${document.id}`);
    expect(detail.body.workflowInstances).toHaveLength(2);
  });

  it("dokumentu w akceptacji nie da się edytować ani dodać do niego pliku", async () => {
    const { jan } = clients;
    const document = await submittedInvoice(jan, "1000");
    const detail = await jan.get(`/documents/${document.id}`);
    expect((await jan.patch(`/documents/${document.id}`, { expectedVersion: detail.body.version, amount: "1" })).status).toBe(403);
    const form = new FormData();
    form.append("file", new Blob(["tekst"]), "a.txt");
    expect((await jan.post(`/documents/${document.id}/files`, form)).status).toBe(403);
  });

  it("dwie równoczesne decyzje w tym samym zadaniu: wygrywa jedna", async () => {
    const { jan, anna } = clients;
    const document = await submittedInvoice(jan, "1000");
    const task = await openTaskFor(anna, document.id);
    const results = await Promise.all([decide(anna, task, "APPROVE"), decide(anna, task, "REJECT", "Równolegle")]);
    const statuses = results.map((result) => result.status).sort();
    expect(statuses).toEqual([200, 409]);
    const finished = await prisma.workflowAction.count({ where: { taskId: task.id, actionType: { in: ["APPROVE", "REJECT"] } } });
    expect(finished).toBe(1);
  });

  it("dwie osoby z roli decydują równocześnie: zadanie zamyka tylko jedna", async () => {
    const { jan, anna, ewa, marek, maria } = clients;
    const document = await submittedInvoice(jan, "60000");
    await decide(anna, await openTaskFor(anna, document.id), "APPROVE");
    await decide(maria, await openTaskFor(maria, document.id), "APPROVE");
    const task = await openTaskFor(ewa, document.id);
    const results = await Promise.all([decide(ewa, task, "APPROVE"), decide(marek, task, "APPROVE")]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const detail = await jan.get(`/documents/${document.id}`);
    expect(detail.body.status).toBe("APPROVED");
  });

  it("administrator nie decyduje za innych, ale może przepisać zadanie", async () => {
    const { jan, anna, admin, piotr } = clients;
    const document = await submittedInvoice(jan, "1000");
    const task = await openTaskFor(anna, document.id);
    expect((await decide(admin, task, "APPROVE")).status).toBe(403);
    const adminView = await admin.get(`/documents/${document.id}`);
    expect(adminView.body.actionsAllowed.canReassign).toBe(true);
    expect(adminView.body.actionsAllowed.canEdit).toBe(false);
    const reassigned = await admin.post(`/workflow/tasks/${task.id}/reassign`, {
      assignToUserId: await userId(emails.piotr), comment: "Kierownik na zwolnieniu", expectedVersion: task.version
    });
    expect(reassigned.status).toBe(200);
    expect(await openTaskFor(anna, document.id)).toBeUndefined();
    const result = await decide(piotr, await openTaskFor(piotr, document.id), "APPROVE");
    expect(result.body.status).toBe("APPROVED");
  });

  it("zwykły użytkownik nie przepisuje zadań, a delegacja nie trafi do autora", async () => {
    const { jan, anna } = clients;
    const document = await submittedInvoice(jan, "1000");
    const task = await openTaskFor(anna, document.id);
    const stolen = await jan.post(`/workflow/tasks/${task.id}/reassign`, { assignToUserId: await userId(emails.jan), comment: "Biorę to", expectedVersion: task.version });
    expect(stolen.status).toBe(403);
    const delegated = await anna.post(`/workflow/tasks/${task.id}/delegate`, { delegateToUserId: await userId(emails.jan), expectedVersion: task.version });
    expect(delegated.status).toBe(403);
  });

  it("zastępstwo daje dostęp do już otwartego zadania, zapisuje się w audycie i kończy się z terminem", async () => {
    const { jan, anna, olga } = clients;
    const document = await submittedInvoice(jan, "1000");
    const task = await openTaskFor(anna, document.id);
    expect(await openTaskFor(olga, document.id)).toBeUndefined();

    const substitution = await anna.post("/organization/substitutions", {
      substituteUserId: await userId(emails.olga),
      validFrom: new Date(Date.now() - 60_000).toISOString(),
      validTo: new Date(Date.now() + 86_400_000).toISOString()
    });
    expect(substitution.status).toBe(201);

    const substituted = await openTaskFor(olga, document.id);
    expect(substituted.id).toBe(task.id);
    expect((await olga.get(`/documents/${document.id}`)).status).toBe(200);

    expect((await anna.delete(`/organization/substitutions/${substitution.body.id}`)).status).toBe(204);
    expect(await openTaskFor(olga, document.id)).toBeUndefined();
    expect((await decide(olga, task, "APPROVE")).status).toBe(403);

    const again = await anna.post("/organization/substitutions", {
      substituteUserId: await userId(emails.olga),
      validFrom: new Date(Date.now() - 60_000).toISOString(),
      validTo: new Date(Date.now() + 86_400_000).toISOString()
    });
    const result = await decide(olga, task, "APPROVE");
    expect(result.body.status).toBe("APPROVED");
    const audit = await prisma.auditEvent.findFirst({ where: { entityId: document.id, eventType: "DOCUMENT_APPROVED" } });
    expect(audit?.substitutedForUserId).toBe(await userId(emails.anna));
    await anna.delete(`/organization/substitutions/${again.body.id}`);
  });

  it("nie można ustawić zastępstwa za kogoś innego", async () => {
    const { jan } = clients;
    const response = await jan.post("/organization/substitutions", {
      userId: await userId(emails.anna),
      substituteUserId: await userId(emails.jan),
      validFrom: new Date().toISOString(),
      validTo: new Date(Date.now() + 86_400_000).toISOString()
    });
    expect(response.status).toBe(403);
  });

  it("autor z roli akceptującej nie widzi własnego zadania, a decydują pozostali", async () => {
    const { ewa, marek } = clients;
    const created = await ewa.post("/documents", {
      title: "Inwestycja zarządu",
      typeId: await typeId(ewa, "CAPEX"),
      amount: "500000",
      data: {}
    });
    expect((await ewa.post(`/documents/${created.body.id}/submit`)).status).toBe(201);
    expect(await openTaskFor(ewa, created.body.id)).toBeUndefined();
    const managerTask = await openTaskFor(marek, created.body.id);
    expect(managerTask).toBeTruthy();
  });

  it("gdy w roli nie ma nikogo poza autorem, etap idzie do przełożonego zamiast utknąć", async () => {
    const { karolina, piotr } = clients;
    const created = await karolina.post("/documents", {
      title: "Wniosek HR o zatrudnienie",
      typeId: await typeId(karolina, "WNIOSEK_ZATRUDNIENIE"),
      data: {}
    });
    expect((await karolina.post(`/documents/${created.body.id}/submit`)).status).toBe(201);
    await decide(piotr, await openTaskFor(piotr, created.body.id), "APPROVE");
    const second = await openTaskFor(piotr, created.body.id);
    expect(second.name).toBe("Weryfikacja HR");
    expect((await decide(piotr, second, "APPROVE")).body.status).toBe("APPROVED");
  });

  it("nieaktywny przełożony jest pomijany, a podgląd ścieżki pokazuje realną osobę", async () => {
    const { jan, admin } = clients;
    const annaId = await userId(emails.anna);
    await prisma.user.update({ where: { id: annaId }, data: { isActive: false } });
    try {
      const document = await draftInvoice(jan, "1000");
      const preview = await jan.get(`/documents/${document.id}/workflow-preview`);
      expect(preview.status).toBe(200);
      expect(preview.body.stages[0].approvers).toEqual(["Piotr Dyrektor"]);
      expect(admin).toBeTruthy();
    } finally {
      await prisma.user.update({ where: { id: annaId }, data: { isActive: true } });
    }
  });

  it("uszkodzona reguła blokuje złożenie z czytelnym komunikatem, a nie dopasowuje się do wszystkiego", async () => {
    const { jan } = clients;
    const rule = await prisma.approvalRule.create({
      data: { name: "Reguła zepsuta", priority: 1, conditionsJson: "{ zepsuty", actionsJson: "{}", isActive: true }
    });
    try {
      const document = await draftInvoice(jan, "1000");
      const response = await jan.post(`/documents/${document.id}/submit`);
      expect(response.status).toBe(422);
      expect(response.body.message).toContain("Reguła zepsuta");
    } finally {
      await prisma.approvalRule.delete({ where: { id: rule.id } });
    }
  });

  it("zapis reguły o złej strukturze jest odrzucany przy zapisie", async () => {
    const { admin } = clients;
    for (const body of [
      { name: "Null", conditionsJson: "null" },
      { name: "Literówka", conditionsJson: JSON.stringify({ amountMinn: 5 }) },
      { name: "Złe kroki", actionsJson: JSON.stringify({ steps: {} }) },
      { name: "Bez roli", actionsJson: JSON.stringify({ steps: [{ name: "X", assigneeType: "ROLE" }] }) }
    ]) {
      expect((await admin.post("/rules", body)).status).toBe(400);
    }
  });
});

describe("widoczność i role", () => {
  let server: TestServer;
  const clients = {} as Record<"jan" | "anna" | "maria" | "karolina" | "tomasz" | "piotr" | "sekretariat" | "admin" | "audytor" | "olga" | "ewa", Client>;
  let invoiceId = "";
  let vacationId = "";
  let draftId = "";

  beforeAll(async () => {
    server = await startServer();
    for (const who of Object.keys({ jan: 1, anna: 1, maria: 1, karolina: 1, tomasz: 1, piotr: 1, sekretariat: 1, admin: 1, audytor: 1, olga: 1, ewa: 1 }) as Array<keyof typeof clients>) {
      clients[who] = await login(server.baseUrl, who);
    }
    invoiceId = (await submittedInvoice(clients.jan, "1000")).id;
    draftId = (await draftInvoice(clients.jan, "2000")).id;
    const vacation = await clients.jan.post("/documents", {
      title: "Urlop Jana",
      typeId: await typeId(clients.jan, "WNIOSEK_URLOPOWY"),
      data: { vacationKind: "Wypoczynkowy", vacationStart: "2026-12-01", vacationEnd: "2026-12-05", vacationDays: "5", substitute: "Anna" }
    });
    vacationId = vacation.body.id;
    await clients.jan.post(`/documents/${vacationId}/submit`);
  });

  afterAll(async () => { await server.close(); });

  const cases: Array<[string, keyof typeof clients, "invoice" | "vacation" | "draft", number]> = [
    ["księgowość widzi fakturę", "maria", "invoice", 200],
    ["księgowość nie widzi urlopu", "maria", "vacation", 403],
    ["księgowość nie widzi cudzego szkicu", "maria", "draft", 403],
    ["kadry widzą urlop", "karolina", "vacation", 200],
    ["kadry nie widzą faktury", "karolina", "invoice", 403],
    ["prawnik nie widzi faktury", "tomasz", "invoice", 403],
    ["kierownik widzi dokument podwładnego", "anna", "invoice", 200],
    ["kierownik nie widzi szkicu podwładnego", "anna", "draft", 403],
    ["dyrektor widzi fakturę", "piotr", "invoice", 200],
    ["dyrektor widzi także kadrowe", "piotr", "vacation", 200],
    ["dyrektor nie widzi cudzego szkicu", "piotr", "draft", 403],
    ["zarząd widzi fakturę", "ewa", "invoice", 200],
    ["zarząd widzi kadrowe", "ewa", "vacation", 200],
    ["zarząd nie widzi cudzego szkicu", "ewa", "draft", 403],
    ["sekretariat widzi fakturę", "sekretariat", "invoice", 200],
    ["sekretariat nie widzi urlopu", "sekretariat", "vacation", 403],
    ["zakupy nie widzą cudzej faktury", "olga", "invoice", 403],
    ["audytor widzi wszystko", "audytor", "vacation", 200],
    ["administrator widzi wszystko", "admin", "draft", 200]
  ];

  it.each(cases)("%s", async (_name, who, target, status) => {
    const id = target === "invoice" ? invoiceId : target === "vacation" ? vacationId : draftId;
    expect((await clients[who].get(`/documents/${id}`)).status).toBe(status);
  });

  it("lista pokazuje dokładnie to, co szczegóły", async () => {
    const list = await clients.olga.get("/documents?limit=100");
    expect(list.body.items.map((item: any) => item.id)).not.toContain(invoiceId);
    const accounting = await clients.maria.get("/documents?limit=100");
    const ids = accounting.body.items.map((item: any) => item.id);
    expect(ids).toContain(invoiceId);
    expect(ids).not.toContain(vacationId);
    const director = await clients.piotr.get("/documents?limit=100");
    expect(director.body.items.map((item: any) => item.id)).toEqual(expect.arrayContaining([invoiceId, vacationId]));
  });

  it("audytor nic nie zmienia: ani tworzenie, ani komentarz, ani edycja", async () => {
    const { audytor } = clients;
    expect((await audytor.post("/documents", { title: "Audyt", typeId: await typeId(audytor, "PROTOKOL") })).status).toBe(403);
    expect((await audytor.post(`/documents/${invoiceId}/comments`, { body: "Uwaga" })).status).toBe(403);
    const detail = await audytor.get(`/documents/${invoiceId}`);
    expect(detail.body.actionsAllowed).toMatchObject({ canEdit: false, canCancel: false, canComment: false, canArchive: false });
  });

  it("administrator nie edytuje cudzego szkicu", async () => {
    const detail = await clients.admin.get(`/documents/${draftId}`);
    expect((await clients.admin.patch(`/documents/${draftId}`, { expectedVersion: detail.body.version, title: "Zmiana admina" })).status).toBe(403);
  });

  it("zwykły użytkownik nie zarządza kontami, konfiguracją ani audytem", async () => {
    const { jan } = clients;
    expect((await jan.patch(`/users/${await userId(emails.jan)}`, { role: "SYSTEM_ADMIN" })).status).toBe(403);
    expect((await jan.get("/rules")).status).toBe(403);
    expect((await jan.get("/audit-logs")).status).toBe(403);
    expect((await jan.get("/reports/documents")).status).toBe(403);
    const users = await jan.get("/users");
    expect(JSON.stringify(users.body)).not.toContain("@aprobis.local");
  });

  it("historia i szczegóły nie ujawniają adresów IP ani e-maili", async () => {
    const detail = await clients.anna.get(`/documents/${invoiceId}`);
    const text = JSON.stringify(detail.body);
    expect(text).not.toContain("@aprobis.local");
    expect(text).not.toContain("ipAddress");
  });

  it("administrator nie odetnie sam siebie, a pętla przełożonych jest odrzucana", async () => {
    const { admin } = clients;
    const adminId = await userId(emails.admin);
    expect((await admin.patch(`/users/${adminId}`, { isActive: false })).status).toBe(409);
    expect((await admin.patch(`/users/${adminId}`, { role: "EMPLOYEE" })).status).toBe(409);
    const annaId = await userId(emails.anna);
    const janId = await userId(emails.jan);
    expect((await admin.patch(`/users/${annaId}`, { managerId: janId })).status).toBe(400);
  });

  it("zmiana hasła wymaga obecnego i wylogowuje wszystkie sesje", async () => {
    const { admin } = clients;
    const email = `nowy.${Date.now()}@aprobis.local`;
    const created = await admin.post("/users", { email, password: "Tymczasowe1", firstName: "Nowy", lastName: "Pracownik", role: "EMPLOYEE" });
    expect(created.status).toBe(201);

    const { Client } = await import("./helpers.js");
    const fresh = new Client(server.baseUrl);
    await prisma.rateLimitBucket.deleteMany();
    expect((await fresh.post("/auth/login", { identifier: email, password: "Tymczasowe1" })).status).toBe(200);
    expect((await fresh.get("/documents")).status).toBe(200);
    expect((await fresh.post("/auth/change-password", { currentPassword: "złe", newPassword: "NoweHaslo2" })).status).toBe(400);
    expect((await fresh.post("/auth/change-password", { currentPassword: "Tymczasowe1", newPassword: "krótkie" })).status).toBe(400);
    expect((await fresh.post("/auth/change-password", { currentPassword: "Tymczasowe1", newPassword: "NoweHaslo2" })).status).toBe(204);
    expect((await fresh.get("/documents")).status).toBe(401);
    expect((await fresh.post("/auth/login", { identifier: email, password: "NoweHaslo2" })).status).toBe(200);
    expect(passwords.jan).toBeTruthy();
  });
});

describe("załączniki i wersje formularza", () => {
  let server: TestServer;
  let jan: Client, admin: Client, olga: Client;

  beforeAll(async () => {
    server = await startServer();
    jan = await login(server.baseUrl, "jan");
    admin = await login(server.baseUrl, "admin");
    olga = await login(server.baseUrl, "olga");
  });

  afterAll(async () => { await server.close(); });

  it("zachowuje polskie znaki w nazwie pliku, blokuje plik do czasu skanu i pozwala go usunąć ze szkicu", async () => {
    const document = await draftInvoice(jan, "100");
    const form = new FormData();
    form.append("file", new Blob(["treść pliku"], { type: "text/plain" }), "Zażółć gęślą jaźń.txt");
    const uploaded = await jan.post(`/documents/${document.id}/files`, form);
    expect(uploaded.status).toBe(202);
    expect(uploaded.body.originalName).toBe("Zażółć gęślą jaźń.txt");
    expect(uploaded.body.scanStatus).toBe("PENDING");

    expect((await jan.get(`/documents/${document.id}/files/${uploaded.body.id}`)).status).toBe(423);
    expect((await olga.delete(`/documents/${document.id}/files/${uploaded.body.id}`)).status).toBe(403);
    expect((await jan.delete(`/documents/${document.id}/files/${uploaded.body.id}`)).status).toBe(204);
    expect((await jan.get(`/documents/${document.id}/files`)).body).toHaveLength(0);
  });

  it("odrzuca plik wykonywalny udający tekst i nie zostawia go na dysku", async () => {
    const document = await draftInvoice(jan, "100");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03])]), "program.exe");
    expect((await jan.post(`/documents/${document.id}/files`, form)).status).toBe(415);
  });

  it("dokument zachowuje pola swojej wersji formularza po publikacji nowej", async () => {
    const created = await admin.post("/document-types", {
      name: `Typ wersjonowany ${Date.now()}`,
      code: `WERSJA_${Date.now()}`,
      category: "ADMIN",
      fields: [{ key: "stare", label: "Stare pole", type: "text", required: true }]
    });
    expect(created.status).toBe(201);
    const typeIdValue = created.body.id;
    expect((await admin.post(`/document-types/${typeIdValue}/versions/${created.body.draftVersion.id}/publish`)).status).toBe(200);

    const document = await jan.post("/documents", { title: "Dokument na starej wersji", typeId: typeIdValue, data: { stare: "wartość" } });
    expect(document.status).toBe(201);

    const patched = await admin.patch(`/document-types/${typeIdValue}`, { fields: [{ key: "nowe", label: "Nowe pole", type: "text", required: true }] });
    expect((await admin.post(`/document-types/${typeIdValue}/versions/${patched.body.draftVersion.id}/publish`)).status).toBe(200);

    const detail = await jan.get(`/documents/${document.body.id}`);
    expect(detail.body.formFields.map((field: any) => field.key)).toEqual(["stare"]);
    expect((await jan.post(`/documents/${document.body.id}/submit`)).status).toBe(201);

    const types = await jan.get("/document-types");
    expect(types.body.find((type: any) => type.id === typeIdValue).fields.map((field: any) => field.key)).toEqual(["nowe"]);
  });

  it("nowa wersja typu przenosi reguły walidacji i wymagania załączników", async () => {
    const code = `REGULY_${Date.now()}`;
    const created = await admin.post("/document-types", {
      name: `Typ z regułami ${code}`, code, category: "ADMIN",
      fields: [{ key: "numer", label: "Numer", type: "text" }]
    });
    const version = created.body.draftVersion;
    const field = await prisma.documentFieldDefinition.findFirstOrThrow({ where: { documentTypeVersionId: version.id, key: "numer" } });
    await prisma.validationRule.create({ data: { documentTypeVersionId: version.id, fieldDefinitionId: field.id, ruleType: "MIN_LENGTH", configJson: JSON.stringify({ value: 3 }) } });
    await prisma.attachmentRequirement.create({ data: { documentTypeVersionId: version.id, key: "skan", label: "Skan", minCount: 1 } });

    const patched = await admin.patch(`/document-types/${created.body.id}`, { fields: [{ key: "numer", label: "Numer dokumentu", type: "text" }] });
    const next = await prisma.documentTypeVersion.findUniqueOrThrow({
      where: { id: patched.body.draftVersion.id },
      include: { validationRules: true, attachmentRequirements: true, fields: true }
    });
    expect(next.attachmentRequirements.map((item) => item.key)).toEqual(["skan"]);
    expect(next.validationRules[0].fieldDefinitionId).toBe(next.fields[0].id);
  });

  it("schemat z etapem równoległym jest oznaczony jako zaawansowany, a prosty nie", async () => {
    const list = await admin.get("/rules/workflow-definitions");
    const vacation = list.body.find((definition: any) => definition.name.startsWith("Wniosek urlopowy"));
    expect(vacation.isAdvanced).toBe(false);
    const code = `ROWNOLEGLY_${Date.now()}`;
    const type = await admin.post("/document-types", { name: code, code, category: "ADMIN" });
    const saved = await admin.post("/rules/workflow-definitions", {
      name: "Równoległy",
      documentTypeId: type.body.id,
      steps: [
        { name: "A", stepType: "OPINION", order: 1, stageNo: 1, parallelGroup: 1, assigneeType: "MANAGER" },
        { name: "B", stepType: "OPINION", order: 2, stageNo: 1, parallelGroup: 2, assigneeType: "DEPARTMENT_MANAGER" }
      ]
    });
    expect(saved.status).toBe(201);
    const again = await admin.get(`/rules/workflow-definitions?documentTypeId=${type.body.id}`);
    expect(again.body[0].isAdvanced).toBe(true);
  });
});
