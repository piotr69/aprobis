import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Wyścigi z przeglądu aplikacji (AP01–AP03). Serwer działa w tym samym procesie, więc
 * „zmianę w międzyczasie” wstawiamy deterministycznie dokładnie tam, gdzie może się zdarzyć:
 * po weryfikacji hasła albo tuż przed transakcją decyzji. Zmiana jest zatwierdzona, zanim
 * żądanie dojdzie do zapisu — tak jak równoległe żądanie innej osoby.
 */
const hooks = vi.hoisted(() => ({
  afterVerify: null as null | (() => Promise<void>),
  beforeTransaction: null as null | (() => Promise<void>)
}));

vi.mock("../../src/shared/password.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/shared/password.js")>();
  return {
    ...original,
    verifyPassword: async (hash: string, password: string) => {
      const result = await original.verifyPassword(hash, password);
      const hook = hooks.afterVerify;
      hooks.afterVerify = null;
      if (hook) await hook();
      return result;
    }
  };
});

vi.mock("../../src/shared/transactions.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/shared/transactions.js")>();
  return {
    ...original,
    serializableTransaction: async <T>(work: Parameters<typeof original.serializableTransaction<T>>[0]) => {
      const hook = hooks.beforeTransaction;
      hooks.beforeTransaction = null;
      if (hook) await hook();
      return original.serializableTransaction(work);
    }
  };
});

const { hashPassword } = await import("../../src/shared/password.js");
const { Client, decide, emails, login, openTaskFor, prisma, startServer, submittedInvoice, userId } = await import("./helpers.js");
type TestServer = Awaited<ReturnType<typeof startServer>>;

afterEach(() => {
  hooks.afterVerify = null;
  hooks.beforeTransaction = null;
});

/** Reset hasła zatwierdzony przez kogoś innego: nowe hasło i unieważnione sesje, jak w /password-reset/confirm. */
async function commitPasswordReset(id: string, newPassword: string) {
  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.user.update({ where: { id }, data: { passwordHash } }),
    prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } })
  ]);
}

describe("AP01: logowanie i zmiana hasła równolegle z resetem", () => {
  let server: TestServer;
  let admin: InstanceType<typeof Client>;

  beforeAll(async () => {
    server = await startServer();
    admin = await login(server.baseUrl, "admin");
  });
  afterAll(async () => { await server.close(); });

  async function newAccount() {
    const stamp = `${Date.now()}${Math.round(Math.random() * 1000)}`;
    const data = { email: `wyscig.${stamp}@firma.test`, login: `wyscig${stamp}`, password: "StareHaslo123", firstName: "Test", role: "EMPLOYEE" };
    const created = await admin.post("/users", data);
    expect(created.status).toBe(201);
    return { id: created.body.id as string, login: data.login };
  }

  async function attempt(identifier: string, password: string) {
    await prisma.rateLimitBucket.deleteMany();
    return new Client(server.baseUrl).post("/auth/login", { identifier, password });
  }

  async function sessionsAfter(id: string, since: Date) {
    return prisma.session.count({ where: { userId: id, revokedAt: null, createdAt: { gte: since } } });
  }

  it("stare hasło nie daje sesji po resecie zatwierdzonym w trakcie logowania", async () => {
    const account = await newAccount();
    const start = new Date();
    hooks.afterVerify = () => commitPasswordReset(account.id, "NoweHaslo123");

    const response = await attempt(account.login, "StareHaslo123");
    expect(response.status).toBe(401);
    expect(await sessionsAfter(account.id, start)).toBe(0);
    expect((await attempt(account.login, "NoweHaslo123")).status).toBe(200);
    expect((await attempt(account.login, "StareHaslo123")).status).toBe(401);
  });

  it("zmiana hasła nie nadpisuje resetu zatwierdzonego po weryfikacji obecnego hasła", async () => {
    const account = await newAccount();
    await prisma.rateLimitBucket.deleteMany();
    const session = new Client(server.baseUrl);
    expect((await session.post("/auth/login", { identifier: account.login, password: "StareHaslo123" })).status).toBe(200);
    hooks.afterVerify = () => commitPasswordReset(account.id, "ZResetu12345");

    const response = await session.post("/auth/change-password", { currentPassword: "StareHaslo123", newPassword: "ZeZmiany1234" });
    expect(response.status).toBe(409);
    expect((await attempt(account.login, "ZResetu12345")).status).toBe(200);
    expect((await attempt(account.login, "ZeZmiany1234")).status).toBe(401);
  });

  it("bez zmiany w międzyczasie logowanie i zmiana hasła działają jak dotąd", async () => {
    const account = await newAccount();
    expect((await attempt(account.login, "StareHaslo123")).status).toBe(200);
    await prisma.rateLimitBucket.deleteMany();
    const session = new Client(server.baseUrl);
    await session.post("/auth/login", { identifier: account.login, password: "StareHaslo123" });
    expect((await session.post("/auth/change-password", { currentPassword: "StareHaslo123", newPassword: "ZeZmiany1234" })).status).toBe(204);
    expect((await attempt(account.login, "ZeZmiany1234")).status).toBe(200);
  });
});

describe("AP02 i AP03: limit akceptacji aktualny w chwili decyzji i zgodny na ekranie", () => {
  let server: TestServer;
  let jan: InstanceType<typeof Client>, anna: InstanceType<typeof Client>, piotr: InstanceType<typeof Client>;

  beforeAll(async () => {
    server = await startServer();
    jan = await login(server.baseUrl, "jan");
    anna = await login(server.baseUrl, "anna");
    piotr = await login(server.baseUrl, "piotr");
  });
  afterAll(async () => {
    await prisma.user.updateMany({ data: { approvalLimitAmount: null, approvalLimitCurrency: "PLN" } });
    await server.close();
  });

  const commitLimit = async (email: string, amount: string | null) => {
    await prisma.user.update({ where: { email }, data: { approvalLimitAmount: amount, approvalLimitCurrency: "PLN" } });
  };

  it("obniżenie limitu zatwierdzone tuż przed decyzją blokuje zatwierdzenie", async () => {
    const document = await submittedInvoice(jan, "1000");
    const task = await openTaskFor(anna, document.id);
    hooks.beforeTransaction = () => commitLimit(emails.anna, "100");

    const response = await decide(anna, task, "APPROVE");
    expect(response.status).toBe(403);
    expect(response.body.message).toContain("limit");
    expect((await prisma.document.findUniqueOrThrow({ where: { id: document.id } })).status).toBe("IN_APPROVAL");
    await commitLimit(emails.anna, null);
  });

  it("obniżenie limitu osoby docelowej tuż przed przekazaniem blokuje przekazanie", async () => {
    const document = await submittedInvoice(jan, "1000");
    const task = await openTaskFor(anna, document.id);
    hooks.beforeTransaction = () => commitLimit(emails.maria, "100");

    const response = await anna.post(`/workflow/tasks/${task.id}/delegate`, { delegateToUserId: await userId(emails.maria), expectedVersion: task.version });
    expect(response.status).toBe(400);
    expect(response.body.message).toContain("limit");
    await commitLimit(emails.maria, null);
  });

  it("zastępca widzi przekroczony limit zastępowanego na liście i w szczegółach", async () => {
    const document = await submittedInvoice(jan, "1000");
    const task = await openTaskFor(anna, document.id);
    const substitution = await anna.post("/organization/substitutions", {
      substituteUserId: await userId(emails.piotr),
      validFrom: new Date(Date.now() - 60_000).toISOString(),
      validTo: new Date(Date.now() + 86_400_000).toISOString()
    });
    expect(substitution.status).toBe(201);

    try {
      const mine = await openTaskFor(piotr, document.id);
      expect(mine.approvalLimitExceeded).toBe(false);

      await commitLimit(emails.anna, "100");
      const listed = await openTaskFor(piotr, document.id);
      expect(listed.approvalLimitExceeded).toBe(true);
      expect((await piotr.get(`/documents/${document.id}`)).body.myTask.approvalLimitExceeded).toBe(true);
      // Ekran zgadza się z decyzją: backend też odmawia.
      expect((await decide(piotr, task, "APPROVE")).status).toBe(403);
    } finally {
      await commitLimit(emails.anna, null);
      await anna.delete(`/organization/substitutions/${substitution.body.id}`);
    }
  });

  it("we własnym imieniu nieużywane zastępstwo nie zmienia flagi limitu", async () => {
    const document = await submittedInvoice(jan, "1000");
    const substitution = await piotr.post("/organization/substitutions", {
      substituteUserId: await userId(emails.anna),
      validFrom: new Date(Date.now() - 60_000).toISOString(),
      validTo: new Date(Date.now() + 86_400_000).toISOString()
    });
    expect(substitution.status).toBe(201);
    try {
      // Anna działa na własnym zadaniu; niski limit Piotra, którego zastępuje, nie ma tu znaczenia.
      await commitLimit(emails.piotr, "100");
      expect((await openTaskFor(anna, document.id)).approvalLimitExceeded).toBe(false);
    } finally {
      await commitLimit(emails.piotr, null);
      await piotr.delete(`/organization/substitutions/${substitution.body.id}`);
    }
  });
});

describe("AP04: role, które mogą decydować", () => {
  it("lista ról mówi formularzom, kogo można wskazać", async () => {
    const server = await startServer();
    try {
      const jan = await login(server.baseUrl, "jan");
      const roles = (await jan.get("/users/roles")).body as Array<{ role: string; decideTasks: boolean }>;
      const decides = Object.fromEntries(roles.map((role) => [role.role, role.decideTasks]));
      expect(decides.SYSTEM_ADMIN).toBe(false);
      expect(decides.AUDITOR).toBe(false);
      expect(decides.EMPLOYEE).toBe(true);
      expect(roles.filter((role) => role.decideTasks === false).length).toBeGreaterThanOrEqual(2);
    } finally {
      await server.close();
    }
  });
});
