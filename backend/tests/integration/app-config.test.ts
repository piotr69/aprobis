import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncAppVersion } from "../../src/shared/appVersion.js";
import { CONFIG_SECRET_MASK } from "../../src/shared/config.js";
import { getSmtpSettings } from "../../src/shared/mailer.js";
import { login, prisma, startServer, type Client, type TestServer } from "./helpers.js";

type Entry = { id: string; key: string; value: string | null; isSystem: boolean; isReadOnly: boolean };

describe("Administracja → Konfiguracja", () => {
  let server: TestServer;
  let admin: Client, jan: Client, audytor: Client;
  const secret = `Haslo-${Date.now()}`;

  async function entry(key: string) {
    const list = await admin.get<Entry[]>("/config");
    return list.body.find((item) => item.key === key)!;
  }

  beforeAll(async () => {
    server = await startServer();
    admin = await login(server.baseUrl, "admin");
    jan = await login(server.baseUrl, "jan");
    audytor = await login(server.baseUrl, "audytor");
  });

  afterAll(async () => {
    await prisma.appConfig.updateMany({ where: { category: "Email" }, data: { value: null, updatedById: null } });
    await prisma.appConfig.deleteMany({ where: { isSystem: false } });
    await server.close();
  });

  it("listę i zmiany widzi tylko administrator, wersję każdy zalogowany", async () => {
    expect((await admin.get("/config")).status).toBe(200);
    for (const client of [jan, audytor]) {
      expect((await client.get("/config")).status).toBe(403);
      expect((await client.post("/config", { key: "X_TEST", value: "1" })).status).toBe(403);
      expect((await client.get("/config/version")).status).toBe(200);
    }
    expect((await admin.get("/auth/me")).body.capabilities.manageConfig).toBe(true);
    expect((await jan.get("/auth/me")).body.capabilities.manageConfig).toBe(false);
  });

  it("hasło nigdy nie wychodzi z bazy: lista, odpowiedź na zapis i audyt mają maskę", async () => {
    const password = await entry("SMTP_PASSWORD");
    const saved = await admin.patch(`/config/${password.id}`, { value: secret });
    expect(saved.status).toBe(200);
    expect(saved.body.value).toBe(CONFIG_SECRET_MASK);
    expect((await entry("SMTP_PASSWORD")).value).toBe(CONFIG_SECRET_MASK);
    expect((await prisma.appConfig.findUnique({ where: { key: "SMTP_PASSWORD" } }))?.value).toBe(secret);

    const audits = await prisma.auditLog.findMany({ where: { entityType: "APP_CONFIG", entityId: password.id } });
    const events = await prisma.auditEvent.findMany({ where: { entityType: "APP_CONFIG", entityId: password.id } });
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify([audits, events])).not.toContain(secret);
  });

  it("odesłana maska zostawia hasło, zmieniona maska jest błędem, null je czyści", async () => {
    const password = await entry("SMTP_PASSWORD");
    expect((await admin.patch(`/config/${password.id}`, { value: CONFIG_SECRET_MASK })).status).toBe(200);
    expect((await prisma.appConfig.findUnique({ where: { key: "SMTP_PASSWORD" } }))?.value).toBe(secret);
    expect((await admin.patch(`/config/${password.id}`, { value: `${CONFIG_SECRET_MASK}x` })).status).toBe(400);
    expect((await admin.patch(`/config/${password.id}`, { value: null })).status).toBe(200);
    expect((await prisma.appConfig.findUnique({ where: { key: "SMTP_PASSWORD" } }))?.value).toBeNull();
  });

  it("hasło ze spacjami na brzegach trafia do bazy i do wysyłki bez zmian", async () => {
    const spaced = ` ${secret} `;
    const host = await entry("SMTP_HOST");
    const password = await entry("SMTP_PASSWORD");
    expect((await admin.patch(`/config/${host.id}`, { value: "  smtp.test.local  " })).status).toBe(200);
    expect((await admin.patch(`/config/${password.id}`, { value: spaced })).status).toBe(200);
    expect((await prisma.appConfig.findUnique({ where: { key: "SMTP_HOST" } }))?.value).toBe("smtp.test.local");
    expect((await prisma.appConfig.findUnique({ where: { key: "SMTP_PASSWORD" } }))?.value).toBe(spaced);
    expect(await getSmtpSettings()).toMatchObject({ host: "smtp.test.local", password: spaced, source: "config" });
    expect((await admin.patch(`/config/${host.id}`, { value: null })).status).toBe(200);
    expect((await admin.patch(`/config/${password.id}`, { value: null })).status).toBe(200);
  });

  it("klucz systemowy: tylko wartość, z walidacją; nie da się go usunąć", async () => {
    const port = await entry("SMTP_PORT");
    expect((await admin.patch(`/config/${port.id}`, { value: "70000" })).status).toBe(400);
    expect((await admin.patch(`/config/${port.id}`, { value: "465" })).status).toBe(200);
    expect((await admin.patch(`/config/${port.id}`, { type: "string" })).status).toBe(400);
    expect((await admin.patch(`/config/${port.id}`, { category: "Inne" })).status).toBe(400);
    expect((await admin.delete(`/config/${port.id}`)).status).toBe(400);
    const secure = await entry("SMTP_SECURE");
    expect((await admin.patch(`/config/${secure.id}`, { value: "tak" })).status).toBe(400);
  });

  it("APP_VERSION ustawia program, administrator go nie zmienia", async () => {
    const version = await entry("APP_VERSION");
    expect(version.isReadOnly).toBe(true);
    expect((await admin.patch(`/config/${version.id}`, { value: "9.9.9" })).status).toBe(400);
  });

  it("własny klucz: dodanie, zmiana, duplikat i usunięcie", async () => {
    const created = await admin.post<Entry>("/config", { key: "LIMIT_TESTOWY", type: "number", value: "5", category: "Testy" });
    expect(created.status).toBe(201);
    expect((await admin.post("/config", { key: "LIMIT_TESTOWY", value: "6" })).status).toBe(409);
    expect((await admin.post("/config", { key: "ZLY KLUCZ", value: "6" })).status).toBe(400);
    expect((await admin.patch(`/config/${created.body.id}`, { value: "abc" })).status).toBe(400);
    expect((await admin.patch(`/config/${created.body.id}`, { value: "7", description: "opis" })).status).toBe(200);
    expect((await admin.delete(`/config/${created.body.id}`)).status).toBe(204);
  });

  it("wersja: zmiana numeru odnawia „Nową wersję”, start z tym samym numerem nie", async () => {
    await prisma.appConfig.update({ where: { key: "APP_VERSION" }, data: { value: "0.0.0-starsza" } });
    await prisma.$executeRaw`UPDATE [dbo].[AppConfig] SET [updatedAt] = DATEADD(day, -5, SYSUTCDATETIME()) WHERE [key] = 'APP_VERSION'`;
    expect((await jan.get("/config/version")).body.isNew).toBe(false);

    await syncAppVersion();
    const fresh = (await jan.get("/config/version")).body;
    expect(fresh.version).not.toBe("0.0.0-starsza");
    expect(fresh.isNew).toBe(true);
    expect(fresh.newRemainingMs).toBeGreaterThan(47 * 60 * 60 * 1000);

    await prisma.$executeRaw`UPDATE [dbo].[AppConfig] SET [updatedAt] = DATEADD(day, -5, SYSUTCDATETIME()) WHERE [key] = 'APP_VERSION'`;
    await syncAppVersion();
    expect((await jan.get("/config/version")).body.isNew).toBe(false);
  });
  it("ukryta gra: domyślnie wyłączona, flagę czyta każdy zalogowany, zmiana działa od następnego zapytania", async () => {
    const flag = await entry("EASTER_EGG_ENABLED");
    expect(flag.isSystem).toBe(true);
    expect(flag.value).toBe("false");
    try {
      expect((await jan.get<{ enabled: boolean }>("/config/easter-egg")).body).toEqual({ enabled: false });
      expect((await admin.patch(`/config/${flag.id}`, { value: "true" })).status).toBe(200);
      expect((await jan.get<{ enabled: boolean }>("/config/easter-egg")).body).toEqual({ enabled: true });
      expect((await admin.patch(`/config/${flag.id}`, { value: "false" })).status).toBe(200);
      expect((await admin.get<{ enabled: boolean }>("/config/easter-egg")).body).toEqual({ enabled: false });
      expect((await admin.patch(`/config/${flag.id}`, { value: null })).status).toBe(200);
      expect((await admin.get<{ enabled: boolean }>("/config/easter-egg")).body).toEqual({ enabled: false });
    } finally {
      await admin.patch(`/config/${flag.id}`, { value: "false" });
    }
  });
});
