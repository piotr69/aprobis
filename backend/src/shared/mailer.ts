import net from "node:net";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { env } from "../config/env.js";
import { getConfigValues } from "./config.js";

const CONNECT_TIMEOUT_MS = 10_000;
/** Limit całej wysyłki. Musi być wyraźnie krótszy od 5-minutowej dzierżawy komunikatu w workerze. */
const SEND_DEADLINE_MS = 60_000;

/** Opcja Nodemailera, której brakuje w jego typach. */
type GetSocket = (options: unknown, callback: (error: Error | null, result: { connection: net.Socket } | null) => void) => void;

function timeoutError(message: string) {
  return Object.assign(new Error(message), { code: "ETIMEDOUT" });
}

export type SmtpSettings = { host: string; port: number; secure: boolean; user?: string; password?: string; from?: string; source: "config" | "env" };

const SMTP_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM"] as const;

/**
 * Ustawienia poczty: z Konfiguracji, a gdy tam nie ma serwera, z pliku .env. Zestaw zawsze pochodzi
 * z jednego źródła, żeby login i hasło jednego serwera nie trafiły do innego. Null: poczta nieskonfigurowana.
 * Błąd odczytu bazy przechodzi wyżej (wysyłka zostanie ponowiona), nie oznacza braku konfiguracji.
 */
export async function getSmtpSettings(): Promise<SmtpSettings | null> {
  const config = await getConfigValues(SMTP_KEYS);
  const source = config.SMTP_HOST
    ? { ...config, origin: "config" as const }
    : {
        SMTP_HOST: env.SMTP_HOST?.trim() || undefined,
        SMTP_PORT: env.SMTP_PORT?.toString(),
        SMTP_SECURE: env.SMTP_SECURE?.trim() || undefined,
        SMTP_USER: env.SMTP_USER?.trim() || undefined,
        SMTP_PASSWORD: env.SMTP_PASSWORD,
        SMTP_FROM: env.SMTP_FROM?.trim() || undefined,
        origin: "env" as const
      };
  if (!source.SMTP_HOST) return null;
  const port = source.SMTP_PORT ? Number(source.SMTP_PORT) : 587;
  return {
    host: source.SMTP_HOST,
    port,
    secure: source.SMTP_SECURE === "true" || port === 465,
    user: source.SMTP_USER,
    password: source.SMTP_PASSWORD,
    from: source.SMTP_FROM,
    source: source.origin
  };
}

/**
 * Wysyłka jednym, wcześniej odczytanym zestawem ustawień (`getSmtpSettings`): sprawdzenie
 * konfiguracji i wysyłka muszą widzieć to samo.
 */
export async function sendMail(
  settings: SmtpSettings,
  message: { to: string; subject: string; text: string; html?: string; messageId?: string },
  { deadlineMs = SEND_DEADLINE_MS }: { deadlineMs?: number } = {}
) {
  const { host, port } = settings;
  // Własne gniazdo, bo limity Nodemailera dotyczą bezczynności, a serwer odpowiadający po kawałku
  // mógłby trzymać jednowątkowego workera bez końca. Zerwanie gniazda przerywa wysyłkę naprawdę.
  let socket: net.Socket | undefined;
  const deadline = setTimeout(() => socket?.destroy(timeoutError("Przekroczono łączny czas wysyłki e-mail")), deadlineMs);
  const getSocket: GetSocket = (_options, callback) => {
    const connection = net.connect({ host, port });
    socket = connection;
    const onTimeout = () => connection.destroy(timeoutError("Przekroczono czas połączenia z serwerem poczty"));
    const onError = (error: Error) => callback(error, null);
    connection.setTimeout(CONNECT_TIMEOUT_MS, onTimeout);
    connection.once("error", onError);
    connection.once("connect", () => {
      connection.off("timeout", onTimeout);
      connection.off("error", onError);
      connection.setTimeout(0);
      // Przy porcie TLS Nodemailer sam podnosi to gniazdo do TLS i weryfikuje certyfikat.
      callback(null, { connection });
    });
  };
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: settings.secure,
    auth: settings.user ? { user: settings.user, pass: settings.password ?? "" } : undefined,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: 30_000,
    getSocket
  } as SMTPTransport.Options);
  try {
    await transporter.sendMail({ from: settings.from ?? settings.user ?? `aprobis@${host}`, ...message });
  } finally {
    clearTimeout(deadline);
  }
}
