import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newVersionRemainingMs, packageVersion, readRelease } from "../src/shared/appVersion.js";
import { CONFIG_SECRET_MASK, maskConfigValue, normalizeConfigValue, validateConfigValue } from "../src/shared/config.js";

describe("wartości konfiguracji", () => {
  it("maskuje hasła i nie zdradza ich długości", () => {
    expect(maskConfigValue("SMTP_PASSWORD", "krotkie")).toBe(CONFIG_SECRET_MASK);
    expect(maskConfigValue("API_SECRET", "x".repeat(80))).toBe(CONFIG_SECRET_MASK);
    expect(maskConfigValue("SMTP_HOST", "serwer.pl")).toBe("serwer.pl");
    expect(maskConfigValue("SMTP_PASSWORD", null)).toBeNull();
  });

  it("przycina zwykłe pola, a hasło zostawia dokładnie takie, jak wpisano", () => {
    expect(normalizeConfigValue("SMTP_HOST", "  serwer.pl ")).toBe("serwer.pl");
    expect(normalizeConfigValue("SMTP_HOST", "   ")).toBeNull();
    expect(normalizeConfigValue("SMTP_PASSWORD", " ha slo ")).toBe(" ha slo ");
    expect(normalizeConfigValue("SMTP_PASSWORD", "")).toBeNull();
    expect(normalizeConfigValue("SMTP_PASSWORD", null)).toBeNull();
  });

  it("sprawdza typ i porty", () => {
    expect(validateConfigValue("X", "number", "12")).toBeNull();
    expect(validateConfigValue("X", "number", "dwanaście")).not.toBeNull();
    expect(validateConfigValue("X", "boolean", "tak")).not.toBeNull();
    expect(validateConfigValue("SMTP_SECURE", "boolean", "true")).toBeNull();
    expect(validateConfigValue("SMTP_PORT", "number", "465")).toBeNull();
    expect(validateConfigValue("SMTP_PORT", "number", "70000")).not.toBeNull();
    expect(validateConfigValue("SMTP_PORT", "number", "4.5")).not.toBeNull();
    expect(validateConfigValue("SMTP_PORT", "number", null)).toBeNull();
  });
});

describe("wersja programu", () => {
  const changed = new Date("2026-11-16T12:00:00Z");

  it("pokazuje „Nowa wersja” przez 2 dni od zmiany numeru", () => {
    expect(newVersionRemainingMs(changed, new Date("2026-11-17T12:00:00Z"))).toBe(24 * 60 * 60 * 1000);
    expect(newVersionRemainingMs(changed, new Date("2026-11-18T12:00:01Z"))).toBe(0);
    expect(newVersionRemainingMs(null, changed)).toBe(0);
  });

  it("czyta release.json zapisany przez PowerShell (z BOM) i skraca commit", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wersja-"));
    writeFileSync(path.join(dir, "release.json"), `\uFEFF{"commit":"34bef84abcdef","zainstalowano":"2026-11-16T13:00:00"}`);
    writeFileSync(path.join(dir, "package.json"), `{"version":"1.1.0"}`);
    expect(readRelease(dir).commit).toBe("34bef84");
    expect(readRelease(dir).installedAt).toBeInstanceOf(Date);
    expect(packageVersion(dir)).toBe("1.1.0");
  });

  it("bez release.json albo z błędnym commitem zwraca puste pola", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wersja-"));
    expect(readRelease(dir)).toEqual({ commit: null, installedAt: null });
    writeFileSync(path.join(dir, "release.json"), `{"commit":"<script>","zainstalowano":"wczoraj"}`);
    expect(readRelease(dir)).toEqual({ commit: null, installedAt: null });
  });
});
