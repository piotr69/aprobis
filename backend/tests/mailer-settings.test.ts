import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  config: {} as Record<string, string>,
  configError: null as Error | null
}));
vi.mock("../src/config/env.js", () => ({ env: state.env }));
vi.mock("../src/shared/config.js", () => ({
  getConfigValues: async () => {
    if (state.configError) throw state.configError;
    return state.config;
  }
}));

const { getSmtpSettings } = await import("../src/shared/mailer.js");

describe("ustawienia poczty: Konfiguracja albo .env", () => {
  beforeEach(() => {
    for (const key of Object.keys(state.env)) delete state.env[key];
    state.config = {};
    state.configError = null;
  });

  it("bez serwera w Konfiguracji bierze cały zestaw z .env", async () => {
    Object.assign(state.env, { SMTP_HOST: "env.local", SMTP_PORT: 465, SMTP_USER: "env-user", SMTP_PASSWORD: "env-pass", SMTP_FROM: "env@example.com" });
    state.config = { SMTP_FROM: "config@example.com" };
    expect(await getSmtpSettings()).toEqual({ host: "env.local", port: 465, secure: true, user: "env-user", password: "env-pass", from: "env@example.com", source: "env" });
  });

  it("z serwerem w Konfiguracji nie miesza loginu ani hasła z .env", async () => {
    Object.assign(state.env, { SMTP_HOST: "env.local", SMTP_USER: "env-user", SMTP_PASSWORD: "env-pass" });
    state.config = { SMTP_HOST: "config.local", SMTP_PORT: "587", SMTP_SECURE: "false" };
    expect(await getSmtpSettings()).toEqual({ host: "config.local", port: 587, secure: false, user: undefined, password: undefined, from: undefined, source: "config" });
  });

  it("bez serwera nigdzie zwraca null", async () => {
    expect(await getSmtpSettings()).toBeNull();
  });

  it("błąd odczytu Konfiguracji przechodzi wyżej, zamiast udawać brak poczty", async () => {
    Object.assign(state.env, { SMTP_HOST: "env.local" });
    state.configError = new Error("baza niedostępna");
    await expect(getSmtpSettings()).rejects.toThrow("baza niedostępna");
  });
});
