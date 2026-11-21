import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exceedsApprovalLimit } from "../../src/shared/approvalLimit.js";
import { generateResetToken } from "../../src/shared/loginPolicy.js";
import { Client, decide, draftInvoice, emails, login, openTaskFor, prisma, startServer, submittedInvoice, typeId, userId, type TestServer } from "./helpers.js";

describe("logowanie i odzyskiwanie hasła", () => {
  let server: TestServer;
  let admin: Client;

  beforeAll(async () => {
    server = await startServer();
    admin = await login(server.baseUrl, "admin");
  });

  afterAll(async () => { await server.close(); });

  async function newAccount(password = "PoczatkoweHaslo1", overrides: Record<string, unknown> = {}) {
    const stamp = `${Date.now()}${Math.round(Math.random() * 1000)}`;
    const data = { email: `konto.${stamp}@firma.test`, login: `konto${stamp}`, password, firstName: "Test", lastName: "Konta", role: "EMPLOYEE", ...overrides };
    const created = await admin.post("/users", data);
    expect(created.status).toBe(201);
    return { id: created.body.id as string, email: data.email, login: data.login as string, password };
  }

  const attempt = async (identifier: string, password: string) => {
    await prisma.rateLimitBucket.deleteMany();
    return new Client(server.baseUrl).post("/auth/login", { identifier, password });
  };

  it("loguje loginem albo e-mailem, bez względu na wielkość liter", async () => {
    const account = await newAccount();
    expect((await attempt(account.login, account.password)).status).toBe(200);
    expect((await attempt(account.email, account.password)).status).toBe(200);
    expect((await attempt(account.login.toUpperCase(), account.password)).status).toBe(200);
  });

  it("po 3 błędach blokuje konto na 15 minut, a potem samo się odblokowuje", async () => {
    const account = await newAccount();
    expect((await attempt(account.login, "zle1")).body.details.code).toBe("INVALID_CREDENTIALS");
    expect((await attempt(account.login, "zle2")).body.details.code).toBe("INVALID_CREDENTIALS");
    expect((await attempt(account.login, "zle3")).body.details.code).toBe("ACCOUNT_LOCKED");
    expect((await attempt(account.login, account.password)).body.details.code).toBe("ACCOUNT_LOCKED");

    await prisma.user.update({ where: { id: account.id }, data: { lockedAt: new Date(Date.now() - 16 * 60 * 1000) } });
    expect((await attempt(account.login, account.password)).status).toBe(200);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: account.id } });
    expect(after.failedLoginAttempts).toBe(0);
    expect(after.lockedAt).toBeNull();
  });

  it("udane logowanie zeruje licznik błędów", async () => {
    const account = await newAccount();
    await attempt(account.login, "zle1");
    await attempt(account.login, "zle2");
    expect((await attempt(account.login, account.password)).status).toBe(200);
    await attempt(account.login, "zle3");
    expect((await attempt(account.login, account.password)).status).toBe(200);
  });

  it("administrator może odblokować konto, a wyłączone nie loguje się wcale", async () => {
    const account = await newAccount();
    for (const bad of ["a", "b", "c"]) await attempt(account.login, bad);
    expect((await admin.get("/users")).body.find((user: any) => user.id === account.id).lockedAt).toBeTruthy();
    expect((await admin.patch(`/users/${account.id}`, { unlock: true })).status).toBe(200);
    expect((await attempt(account.login, account.password)).status).toBe(200);

    await admin.patch(`/users/${account.id}`, { isActive: false });
    expect((await attempt(account.login, account.password)).body.details.code).toBe("ACCOUNT_INACTIVE");
  });

  it("nie zdradza, czy konto istnieje", async () => {
    expect((await attempt("nie-ma-takiego-konta", "cokolwiek")).body.message).toBe((await attempt(emails.jan, "złe-hasło")).body.message);
    await prisma.user.update({ where: { email: emails.jan }, data: { failedLoginAttempts: 0, lockedAt: null } });
    const client = new Client(server.baseUrl);
    await prisma.rateLimitBucket.deleteMany();
    const unknown = await client.post("/auth/password-reset", { identifier: "nie-ma-takiego-konta" });
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual({ ok: true });
  });

  it("prośba o reset zapisuje tylko skrót tokenu i nie zmienia hasła", async () => {
    const account = await newAccount();
    await prisma.rateLimitBucket.deleteMany();
    expect((await new Client(server.baseUrl).post("/auth/password-reset", { identifier: account.login })).body).toEqual({ ok: true });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: account.id } });
    expect(user.resetTokenHash).toHaveLength(64);
    expect(user.resetTokenExpires!.getTime()).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
    expect((await attempt(account.login, account.password)).status).toBe(200);
  });

  it("link działa raz, zdejmuje blokadę i wylogowuje wszystkie sesje", async () => {
    const account = await newAccount();
    const session = new Client(server.baseUrl);
    await prisma.rateLimitBucket.deleteMany();
    await session.post("/auth/login", { identifier: account.login, password: account.password });
    for (const bad of ["a", "b", "c"]) await attempt(account.login, bad);

    const { token, tokenHash, expiresAt } = generateResetToken();
    await prisma.user.update({ where: { id: account.id }, data: { resetTokenHash: tokenHash, resetTokenExpires: expiresAt } });
    const client = new Client(server.baseUrl);
    expect((await client.post("/auth/password-reset/confirm", { token, password: "krótkie" })).status).toBe(400);
    expect((await client.post("/auth/password-reset/confirm", { token, password: "NoweHaslo123" })).status).toBe(200);
    expect((await client.post("/auth/password-reset/confirm", { token, password: "InneHaslo123" })).status).toBe(400);

    expect((await session.get("/documents")).status).toBe(401);
    expect((await attempt(account.login, "NoweHaslo123")).status).toBe(200);
    expect((await attempt(account.login, account.password)).status).toBe(401);
  });

  it("zmiana hasła przez użytkownika unieważnia wcześniejszy link", async () => {
    const account = await newAccount();
    const { token, tokenHash, expiresAt } = generateResetToken();
    await prisma.user.update({ where: { id: account.id }, data: { resetTokenHash: tokenHash, resetTokenExpires: expiresAt } });
    await prisma.rateLimitBucket.deleteMany();
    const session = new Client(server.baseUrl);
    await session.post("/auth/login", { identifier: account.login, password: account.password });
    expect((await session.post("/auth/change-password", { currentPassword: account.password, newPassword: "NoweHaslo123" })).status).toBe(204);
    expect((await new Client(server.baseUrl).post("/auth/password-reset/confirm", { token, password: "PrzejeteHaslo1" })).status).toBe(400);
    expect((await attempt(account.login, "NoweHaslo123")).status).toBe(200);
  });

  it("nowe hasło od administratora unieważnia wcześniejszy link", async () => {
    const account = await newAccount();
    const { token, tokenHash, expiresAt } = generateResetToken();
    await prisma.user.update({ where: { id: account.id }, data: { resetTokenHash: tokenHash, resetTokenExpires: expiresAt } });
    expect((await admin.patch(`/users/${account.id}`, { password: "OdAdministratora1" })).status).toBe(200);
    expect((await new Client(server.baseUrl).post("/auth/password-reset/confirm", { token, password: "PrzejeteHaslo1" })).status).toBe(400);
    expect((await attempt(account.login, "OdAdministratora1")).status).toBe(200);
  });

  it("wygasły link nie działa", async () => {
    const account = await newAccount();
    const { token, tokenHash } = generateResetToken();
    await prisma.user.update({ where: { id: account.id }, data: { resetTokenHash: tokenHash, resetTokenExpires: new Date(Date.now() - 1000) } });
    expect((await new Client(server.baseUrl).post("/auth/password-reset/confirm", { token, password: "NoweHaslo123" })).status).toBe(400);
  });

  it("login i e-mail są unikalne krzyżowo i nie wyciekają dane resetu", async () => {
    const account = await newAccount();
    expect((await admin.post("/users", { email: "inny@firma.test", login: account.login, password: "PoczatkoweHaslo1", firstName: "A", role: "EMPLOYEE" })).status).toBe(409);
    expect((await admin.post("/users", { email: "z@firma.test", login: "z@firma.test", password: "PoczatkoweHaslo1", firstName: "A", role: "EMPLOYEE" })).status).toBe(400);
    const text = JSON.stringify((await admin.get("/users")).body);
    expect(text).not.toContain("resetToken");
    expect(text).not.toContain("passwordHash");
  });

  it("hasło ma co najmniej 8 znaków, a nazwisko nie jest obowiązkowe", async () => {
    const short = await admin.post("/users", { email: "krotkie@firma.test", password: "1234567", firstName: "A", role: "EMPLOYEE" });
    expect(short.status).toBe(400);
    const stamp = Date.now();
    const created = await admin.post("/users", { email: `osiem.${stamp}@firma.test`, password: "12345678", firstName: "Administrator", role: "EMPLOYEE" });
    expect(created.status).toBe(201);
  });

  it("administrator nie zmieni własnej roli ani nie wyłączy własnego konta", async () => {
    const adminId = await userId(emails.admin);
    expect((await admin.patch(`/users/${adminId}`, { role: "EMPLOYEE" })).status).toBe(409);
    expect((await admin.patch(`/users/${adminId}`, { isActive: false })).status).toBe(409);
  });
});

describe("limity akceptacji ustawiane przez administratora", () => {
  let server: TestServer;
  let jan: Client, anna: Client, piotr: Client, maria: Client, ewa: Client, marek: Client, admin: Client;

  beforeAll(async () => {
    server = await startServer();
    jan = await login(server.baseUrl, "jan");
    anna = await login(server.baseUrl, "anna");
    piotr = await login(server.baseUrl, "piotr");
    maria = await login(server.baseUrl, "maria");
    ewa = await login(server.baseUrl, "ewa");
    marek = await login(server.baseUrl, "marek");
    admin = await login(server.baseUrl, "admin");
  });

  afterAll(async () => {
    await prisma.user.updateMany({ data: { approvalLimitAmount: null, approvalLimitCurrency: "PLN" } });
    await server.close();
  });

  const setLimit = async (email: string, amount: string | null, currency = "PLN") => {
    const response = await admin.patch(`/users/${await userId(email)}`, { approvalLimitAmount: amount, approvalLimitCurrency: currency });
    expect(response.status).toBe(200);
  };

  it("tylko administrator ustawia limit, a brak limitu to brak ograniczenia", async () => {
    expect((await jan.patch(`/users/${await userId(emails.anna)}`, { approvalLimitAmount: "100" })).status).toBe(403);
    expect((await admin.patch(`/users/${await userId(emails.anna)}`, { approvalLimitAmount: "abc" })).status).toBe(400);
    const document = await submittedInvoice(jan, "1000");
    const listed = (await admin.get("/users")).body.find((user: any) => user.email === emails.anna);
    expect(listed.approvalLimitAmount).toBeNull();
    expect((await decide(anna, await openTaskFor(anna, document.id), "APPROVE")).body.status).toBe("APPROVED");
    expect((await jan.get("/users")).body.every((user: any) => user.approvalLimitAmount === undefined)).toBe(true);
  });

  it("kwota ponad limit przełożonego kieruje etap wyżej, a kwota w limicie zostaje u niego", async () => {
    await setLimit(emails.anna, "5000");
    const within = await draftInvoice(jan, "1000");
    const inPreview = await jan.get(`/documents/${within.id}/workflow-preview`);
    expect(inPreview.body.stages[0].approvers).toEqual(["Anna Kierownik"]);

    const over = await draftInvoice(jan, "6000");
    const overPreview = await jan.get(`/documents/${over.id}/workflow-preview`);
    expect(overPreview.body.stages[0].approvers).toEqual(["Piotr Dyrektor"]);
    await jan.post(`/documents/${over.id}/submit`);
    expect(await openTaskFor(anna, over.id)).toBeUndefined();
    expect(await openTaskFor(piotr, over.id)).toBeTruthy();
    await setLimit(emails.anna, null);
  });

  it("kwota równa limitowi mieści się w nim, a limit w innej walucie liczy się jako przekroczony", async () => {
    await setLimit(emails.anna, "1000");
    const equal = await draftInvoice(jan, "1000");
    expect((await jan.get(`/documents/${equal.id}/workflow-preview`)).body.stages[0].approvers).toEqual(["Anna Kierownik"]);
    const foreign = await draftInvoice(jan, "10", "EUR");
    expect((await jan.get(`/documents/${foreign.id}/workflow-preview`)).body.stages[0].approvers).toEqual(["Piotr Dyrektor"]);
    await setLimit(emails.anna, null);
  });

  it("limit obniżony po przydzieleniu blokuje zatwierdzenie, ale nie zwrot i przekazanie", async () => {
    const document = await submittedInvoice(jan, "3000");
    const task = await openTaskFor(anna, document.id);
    await setLimit(emails.anna, "1000");
    const mine = await openTaskFor(anna, document.id);
    expect(mine.approvalLimitExceeded).toBe(true);
    expect((await anna.get(`/documents/${document.id}`)).body.myTask.approvalLimitExceeded).toBe(true);
    const denied = await decide(anna, task, "APPROVE");
    expect(denied.status).toBe(403);
    expect(denied.body.message).toContain("limit");

    const tooLow = await anna.post(`/workflow/tasks/${task.id}/delegate`, { delegateToUserId: await userId(emails.maria), expectedVersion: task.version });
    expect(tooLow.status).toBe(200);
    await setLimit(emails.anna, null);
  });

  it("nie można przekazać zadania osobie z za niskim limitem", async () => {
    await setLimit(emails.maria, "100");
    const document = await submittedInvoice(jan, "3000");
    const task = await openTaskFor(anna, document.id);
    const response = await anna.post(`/workflow/tasks/${task.id}/delegate`, { delegateToUserId: await userId(emails.maria), expectedVersion: task.version });
    expect(response.status).toBe(400);
    expect(response.body.message).toContain("limit");
    await setLimit(emails.maria, null);
  });

  it("zadanie z roli pokazuje się tylko osobom, których limit wystarcza", async () => {
    await setLimit(emails.ewa, "1000");
    const document = await submittedInvoice(jan, "60000");
    await decide(anna, await openTaskFor(anna, document.id), "APPROVE");
    await decide(maria, await openTaskFor(maria, document.id), "APPROVE");
    expect(await openTaskFor(ewa, document.id)).toBeUndefined();
    const task = await openTaskFor(marek, document.id);
    expect(task).toBeTruthy();
    expect((await decide(ewa, task, "APPROVE")).status).toBe(403);
    expect((await decide(marek, task, "APPROVE")).body.status).toBe("APPROVED");
    await setLimit(emails.ewa, null);
  });

  it("zastępca nie obejdzie limitu ani swojego, ani zastępowanego", async () => {
    const document = await submittedInvoice(jan, "3000");
    const task = await openTaskFor(anna, document.id);
    const body = { substituteUserId: await userId(emails.piotr), validFrom: new Date(Date.now() - 60_000).toISOString(), validTo: new Date(Date.now() + 86_400_000).toISOString() };
    const substitution = await anna.post("/organization/substitutions", body);
    await setLimit(emails.anna, "1000");
    expect((await decide(piotr, task, "APPROVE")).status).toBe(403);
    await setLimit(emails.anna, null);
    await setLimit(emails.piotr, "1000");
    expect((await decide(piotr, task, "APPROVE")).status).toBe(403);
    await setLimit(emails.piotr, null);
    await anna.delete(`/organization/substitutions/${substitution.body.id}`);
  });

  it("dokument bez kwoty nie przekracza żadnego limitu", async () => {
    await setLimit(emails.anna, "1");
    const created = await jan.post("/documents", { title: "Notatka bez kwoty", typeId: await typeId(jan, "NOTATKA_SLUZBOWA") });
    expect((await jan.get(`/documents/${created.body.id}/workflow-preview`)).body.stages[0].approvers).toEqual(["Anna Kierownik"]);
    await setLimit(emails.anna, null);
  });

  it("limit porównuje kwoty co do grosza, także bardzo duże", () => {
    const limit = (amount: string) => ({ approvalLimitAmount: amount, approvalLimitCurrency: "PLN" });
    const doc = (amount: string) => ({ amount, currency: "PLN" });
    expect(exceedsApprovalLimit(limit("9007199254740992.00"), doc("9007199254740993.00"))).toBe(true);
    expect(exceedsApprovalLimit(limit("9007199254740993.00"), doc("9007199254740993.00"))).toBe(false);
    expect(exceedsApprovalLimit(limit("9999999999999999.98"), doc("9999999999999999.99"))).toBe(true);
    expect(exceedsApprovalLimit(limit("1000.00"), doc("1000.01"))).toBe(true);
    expect(exceedsApprovalLimit(limit("1000"), doc("1000.00"))).toBe(false);
  });

  it("dokument o groszu ponad bardzo duży limit nie trafia do tej osoby", async () => {
    await setLimit(emails.anna, "9007199254740992.00");
    const document = await draftInvoice(jan, "9007199254740993.00");
    expect((await jan.get(`/documents/${document.id}/workflow-preview`)).body.stages[0].approvers).toEqual(["Piotr Dyrektor"]);
    await setLimit(emails.anna, null);
  });

  it("gdy nikt nie ma dość wysokiego limitu, złożenie kończy się komunikatem", async () => {
    const people = [emails.anna, emails.piotr, emails.ewa, emails.marek];
    for (const email of people) await setLimit(email, "10");
    const document = await draftInvoice(jan, "1000");
    const response = await jan.post(`/documents/${document.id}/submit`);
    expect(response.status).toBe(422);
    expect(response.body.message).toContain("limit");
    for (const email of people) await setLimit(email, null);
  });
});
