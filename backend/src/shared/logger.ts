import fs from "node:fs";
import path from "node:path";

type LogLevel = "debug" | "info" | "warn" | "error";

const sensitiveKeys = new Set(["password", "passwordHash", "token", "authorization", "cookie"]);

function redact(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(redact);
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, sensitiveKeys.has(key) ? "[REDACTED]" : redact(nested)])
  );
}

type LoggerConfig = {
  /** Kto pisze: "api" albo "worker". Trafia do bazy i do nazwy pliku. */
  source: string;
  /** Katalog dziennych plików. Bez niego tylko konsola. */
  directory?: string;
  /** Czy zapisywać wpisy (bez debug) do tabeli SystemLog. */
  persist: boolean;
  /** Bez konsoli: na produkcji konsola idzie do pliku zadania, który rósłby bez końca. */
  quietConsole: boolean;
};

type SystemLogRow = { createdAt: Date; level: LogLevel; source: string; message: string; contextJson: string | null };

const MAX_BUFFER = 2_000;
const BATCH_SIZE = 200;
const FLUSH_INTERVAL_MS = 2_000;
const MAX_CONTEXT_CHARS = 20_000;

let config: LoggerConfig = { source: "app", persist: false, quietConsole: false };
let buffer: SystemLogRow[] = [];
let dropped = 0;
let flushing: Promise<void> | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let fileChain: Promise<void> = Promise.resolve();
let lastFailureReportAt = 0;

/**
 * Włącza zapis do plików i bazy. Wołają to tylko procesy API i workera; testy i skrypty
 * zostają przy samej konsoli, więc niczego nie zapisują do bazy mimochodem.
 */
export function configureLogger(next: Partial<LoggerConfig>) {
  config = { ...config, ...next };
  if (config.directory) fs.mkdirSync(config.directory, { recursive: true });
  if (config.persist && !flushTimer) {
    flushTimer = setInterval(() => { void flushLogs(); }, FLUSH_INTERVAL_MS);
    flushTimer.unref();
  }
}

/** Nazwa pliku z lokalną datą serwera, np. api-2026-11-06.log. */
export function logFileName(source: string, at: Date) {
  return `${source}-${at.toLocaleDateString("sv-SE")}.log`;
}

function writeConsole(level: LogLevel, line: string) {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function appendToFile(line: string, at: Date) {
  const directory = config.directory;
  if (!directory) return;
  const file = path.join(directory, logFileName(config.source, at));
  // Łańcuch zachowuje kolejność wpisów w pliku.
  fileChain = fileChain
    .then(() => fs.promises.appendFile(file, `${line}\n`, "utf8"))
    .catch((error) => console.error(JSON.stringify({ level: "error", message: "Nie udało się zapisać logu do pliku", file, error: String(error) })));
}

function enqueue(row: SystemLogRow) {
  buffer.push(row);
  if (buffer.length > MAX_BUFFER) {
    // Baza długo nie przyjmuje wpisów: tracimy najstarsze, plik dzienny ma je nadal.
    dropped += buffer.length - MAX_BUFFER;
    buffer = buffer.slice(-MAX_BUFFER);
  }
}

/** Zapisuje zaległe wpisy do bazy. Błąd bazy nie zatrzymuje programu: wpisy są w pliku. */
export function flushLogs(): Promise<void> {
  if (flushing) return flushing;
  if (!buffer.length && !dropped) return Promise.resolve();
  flushing = (async () => {
    try {
      const { prisma } = await import("./prisma.js");
      if (dropped) {
        const lost = dropped;
        dropped = 0;
        buffer.unshift({
          createdAt: new Date(), level: "warn", source: config.source,
          message: "Część logów nie trafiła do bazy (są w pliku dziennym)", contextJson: JSON.stringify({ lost })
        });
      }
      while (buffer.length) {
        const batch = buffer.splice(0, BATCH_SIZE);
        try {
          await prisma.systemLog.createMany({ data: batch });
        } catch (error) {
          dropped += batch.length;
          // Przy dłuższej awarii bazy raz na minutę, a nie co 2 sekundy.
          if (Date.now() - lastFailureReportAt < 60_000) return;
          lastFailureReportAt = Date.now();
          const line = JSON.stringify({ timestamp: new Date().toISOString(), level: "error", source: config.source, message: "Nie udało się zapisać logów do bazy", error: String(error) });
          console.error(line);
          appendToFile(line, new Date());
          return;
        }
      }
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

/** Czeka na zapis do plików i bazy, np. przed zamknięciem procesu albo w teście. */
export async function drainLogs() {
  await flushLogs();
  await fileChain;
}

function write(level: LogLevel, message: string, context?: Record<string, unknown>) {
  const safeContext = redact(context ?? {}) as Record<string, unknown>;
  const at = new Date();
  const line = JSON.stringify({ timestamp: at.toISOString(), level, source: config.source, message, ...safeContext });
  if (!config.quietConsole) writeConsole(level, line);
  appendToFile(line, at);
  if (config.persist && level !== "debug") {
    const contextJson = Object.keys(safeContext).length ? JSON.stringify(safeContext).slice(0, MAX_CONTEXT_CHARS) : null;
    enqueue({ createdAt: at, level, source: config.source, message: message.slice(0, 500), contextJson });
  }
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => write("debug", message, context),
  info: (message: string, context?: Record<string, unknown>) => write("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => write("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => write("error", message, context)
};
