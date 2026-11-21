import { prisma } from "./prisma.js";

/**
 * Odczyt tabeli AppConfig (ekran Administracja → Konfiguracja).
 *
 * API i worker to osobne procesy z osobną pamięcią podręczną. Zmiana zapisana w API czyści
 * tylko jej kopię, więc worker widzi nową wartość najpóźniej po CONFIG_CACHE_TTL_MS.
 * Błąd odczytu bazy nie trafia do pamięci podręcznej: wywołujący dostaje wyjątek, a nie pustą konfigurację.
 */
export const CONFIG_CACHE_TTL_MS = 30_000;

type Snapshot = { values: Map<string, string>; loadedAt: number };

let cache: Snapshot | null = null;
// Odczyt rozpoczęty przed `clearConfigCache` nie może nadpisać świeższego stanu.
let generation = 0;

async function snapshot(): Promise<Map<string, string>> {
  if (cache && Date.now() - cache.loadedAt < CONFIG_CACHE_TTL_MS) return cache.values;
  const started = generation;
  const rows = await prisma.appConfig.findMany({ select: { key: true, value: true } });
  const values = new Map<string, string>();
  for (const row of rows) {
    const value = normalizeConfigValue(row.key, row.value);
    if (value !== null) values.set(row.key, value);
  }
  if (started === generation) cache = { values, loadedAt: Date.now() };
  return values;
}

export function clearConfigCache() {
  generation += 1;
  cache = null;
}

/** Wartości podanych kluczy z jednego odczytu. Pusty klucz nie występuje w wyniku. */
export async function getConfigValues<K extends string>(keys: readonly K[]): Promise<Partial<Record<K, string>>> {
  const values = await snapshot();
  const result: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const value = values.get(key);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

// --- Sekrety -------------------------------------------------------------------------------

const SECRET_KEY_PATTERN = /(PASSWORD|SECRET)/i;
export const CONFIG_SECRET_MASK = "••••••••";

export function isSecretConfigKey(key: string) {
  return SECRET_KEY_PATTERN.test(key);
}

/**
 * Wartość do zapisu i użycia: zwykłe pola bez spacji na brzegach, hasła dokładnie tak, jak je wpisano
 * (spacja na końcu bywa częścią hasła). Pusty tekst to brak ustawienia.
 */
export function normalizeConfigValue(key: string, value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (isSecretConfigKey(key)) return value === "" ? null : value;
  return value.trim() || null;
}

/** Wartość do pokazania poza bazą: API, audyt, logi. Sekret zawsze jako maska, także pusty nie zdradza długości. */
export function maskConfigValue(key: string, value: string | null) {
  if (value === null || value === "") return value;
  return isSecretConfigKey(key) ? CONFIG_SECRET_MASK : value;
}

// --- Typy wartości ---------------------------------------------------------------------------

export const CONFIG_TYPES = ["string", "number", "boolean"] as const;
export type ConfigType = (typeof CONFIG_TYPES)[number];

/** Dodatkowe zasady dla kluczy, których źle wpisana wartość psuje działanie programu. */
const KEY_RULES: Record<string, (value: string) => string | null> = {
  SMTP_PORT: (value) => (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535 ? null : "Port musi być liczbą całkowitą od 1 do 65535")
};

/** Komunikat błędu albo null. Pusta wartość jest zawsze dozwolona: oznacza brak ustawienia. */
export function validateConfigValue(key: string, type: string, value: string | null): string | null {
  if (value === null || value === "") return null;
  if (type === "number" && !/^-?\d+(\.\d+)?$/.test(value)) return "Wartość musi być liczbą";
  if (type === "boolean" && value !== "true" && value !== "false") return "Wartość musi być true albo false";
  return KEY_RULES[key]?.(value) ?? null;
}
