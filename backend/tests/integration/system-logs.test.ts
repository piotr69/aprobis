import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureLogger, drainLogs, logFileName, logger } from "../../src/shared/logger.js";
import { purgeOldLogs } from "../../src/modules/system-logs/system-logs.service.js";
import { Client, emails, login, prisma, startServer, type TestServer } from "./helpers.js";

describe("logi systemowe i dziennik zdarzeń", () => {
  let server: TestServer;
  let admin: Client, audytor: Client, jan: Client;
  let directory: string;

  beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-logs-"));
    // Jak proces API: zapis do pliku dziennego i do bazy.
    configureLogger({ source: "api", directory, persist: true, quietConsole: true });
    server = await startServer();
    admin = await login(server.baseUrl, "admin");
    audytor = await login(server.baseUrl, "audytor");
    jan = await login(server.baseUrl, "jan");
  });

  afterAll(async () => {
    configureLogger({ directory: undefined, persist: false, quietConsole: false });
    await server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("dziennik zdarzeń i logi systemowe widzi tylko administrator", async () => {
    expect((await admin.get("/audit-logs")).status).toBe(200);
    expect((await admin.get("/system-logs")).status).toBe(200);
    for (const client of [audytor, jan]) {
      expect((await client.get("/audit-logs")).status).toBe(403);
      expect((await client.get("/system-logs")).status).toBe(403);
    }
    expect((await audytor.get("/auth/me")).body.capabilities).toMatchObject({ viewAudit: false, viewSystemLogs: false });
    expect((await admin.get("/auth/me")).body.capabilities).toMatchObject({ viewAudit: true, viewSystemLogs: true });
  });

  it("nieudane logowanie trafia do bazy i do pliku dziennego, bez wpisanego hasła", async () => {
    await prisma.rateLimitBucket.deleteMany();
    const anonymous = new Client(server.baseUrl);
    const secret = `Tajne-${Date.now()}`;
    expect((await anonymous.post("/auth/login", { identifier: emails.jan, password: secret })).status).toBe(401);
    await prisma.user.update({ where: { email: emails.jan }, data: { failedLoginAttempts: 0, lockedAt: null } });
    await drainLogs();

    const found = await admin.get("/system-logs?level=warn&search=" + encodeURIComponent("złe hasło"));
    expect(found.status).toBe(200);
    const entry = found.body.items[0];
    expect(entry).toMatchObject({ level: "warn", source: "api", message: "Nieudane logowanie: złe hasło" });
    const janId = (await prisma.user.findUniqueOrThrow({ where: { email: emails.jan }, select: { id: true } })).id;
    expect(JSON.parse(entry.contextJson)).toMatchObject({ userId: janId, attempts: 1 });

    const file = fs.readFileSync(path.join(directory, logFileName("api", new Date())), "utf8");
    expect(file).toContain("Nieudane logowanie: złe hasło");
    expect(file).not.toContain(secret);
    expect(JSON.stringify(found.body)).not.toContain(secret);
  });

  it("filtr poziomu odrzuca nieznane wartości, a stronicowanie nie gubi wpisów z tej samej chwili", async () => {
    expect((await admin.get("/system-logs?level=fatal")).status).toBe(400);
    const marker = `paczka-${Date.now()}`;
    for (let index = 0; index < 5; index += 1) logger.error(marker, { index });
    await drainLogs();

    const seen: number[] = [];
    let cursor = "";
    for (let page = 0; page < 5; page += 1) {
      const result = await admin.get(`/system-logs?take=2&search=${marker}${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...result.body.items.map((item: { contextJson: string }) => JSON.parse(item.contextJson).index));
      if (!result.body.hasMore) break;
      cursor = result.body.items[result.body.items.length - 1].id;
    }
    expect(seen.sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it("sprzątanie usuwa logi starsze niż okres przechowywania, nowsze i obce pliki zostawia", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000);
    const recent = new Date(now.getTime() - 89 * 24 * 60 * 60 * 1000);
    const marker = `retencja-${Date.now()}`;
    await prisma.systemLog.createMany({
      data: [
        { createdAt: old, level: "info", source: "api", message: `${marker}-stary` },
        { createdAt: recent, level: "info", source: "api", message: `${marker}-nowy` }
      ]
    });
    fs.writeFileSync(path.join(directory, logFileName("worker", old)), "stary\n");
    fs.writeFileSync(path.join(directory, logFileName("worker", recent)), "nowy\n");
    fs.writeFileSync(path.join(directory, "notatka.txt"), "nie ruszać\n");
    fs.writeFileSync(path.join(directory, logFileName("other-app", old)), "cudzy\n");

    const purged = await purgeOldLogs(90, directory, now);

    expect(purged.rows).toBeGreaterThanOrEqual(1);
    expect(await prisma.systemLog.findMany({ where: { message: { startsWith: marker } }, select: { message: true } }))
      .toEqual([{ message: `${marker}-nowy` }]);
    expect(fs.existsSync(path.join(directory, logFileName("worker", old)))).toBe(false);
    expect(fs.existsSync(path.join(directory, logFileName("worker", recent)))).toBe(true);
    expect(fs.existsSync(path.join(directory, "notatka.txt"))).toBe(true);
    expect(fs.existsSync(path.join(directory, logFileName("other-app", old)))).toBe(true);
    // Audytu sprzątanie nie dotyka.
    expect(await prisma.auditLog.count()).toBeGreaterThan(0);
  });
});
