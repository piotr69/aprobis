import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const mailEnv = vi.hoisted(() => ({ SMTP_HOST: "127.0.0.1", SMTP_PORT: 0, SMTP_SECURE: "false", SMTP_FROM: "aprobis@test.local" }));
vi.mock("../src/config/env.js", () => ({ env: mailEnv }));
vi.mock("../src/shared/config.js", () => ({ getConfigValues: async () => ({}) }));

const { getSmtpSettings, sendMail: sendWith } = await import("../src/shared/mailer.js");

/** Ustawienia z pliku .env (Konfiguracja w tym teście jest pusta), czytane przy każdej wysyłce, bo port się zmienia. */
async function sendMail(...args: [Parameters<typeof sendWith>[1], Parameters<typeof sendWith>[2]?]) {
  const settings = await getSmtpSettings();
  if (!settings) throw new Error("brak ustawień SMTP w teście");
  return sendWith(settings, ...args);
}

const message = { to: "odbiorca@test.local", subject: "Temat", text: "Treść" };

/** Serwer SMTP na 127.0.0.1. `afterData` decyduje, co dzieje się po przyjęciu treści wiadomości. */
function smtpServer(afterData: (socket: net.Socket) => void) {
  const state = { closed: 0, timers: [] as NodeJS.Timeout[] };
  const server = net.createServer((socket) => {
    let inData = false;
    let buffer = "";
    socket.on("close", () => { state.closed += 1; });
    socket.on("error", () => undefined);
    socket.write("220 test\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (inData) {
        if (buffer.endsWith("\r\n.\r\n")) {
          inData = false;
          buffer = "";
          afterData(socket);
        }
        return;
      }
      const lines = buffer.split("\r\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (/^(EHLO|HELO|MAIL|RCPT|RSET)/i.test(line)) socket.write("250 OK\r\n");
        else if (/^DATA/i.test(line)) { inData = true; socket.write("354 go\r\n"); }
        else if (/^QUIT/i.test(line)) socket.end("221 bye\r\n");
      }
    });
  });
  return new Promise<{ server: net.Server; state: typeof state }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      mailEnv.SMTP_PORT = (server.address() as AddressInfo).port;
      resolve({ server, state });
    });
  });
}

describe("limit czasu wysyłki e-mail", () => {
  let running: { server: net.Server; state: { timers: NodeJS.Timeout[] } } | undefined;

  afterEach(async () => {
    running?.state.timers.forEach(clearInterval);
    await new Promise((resolve) => running?.server.close(resolve));
  });

  it("wysyła zwykłą wiadomość", async () => {
    running = await smtpServer((socket) => socket.write("250 przyjeto\r\n"));
    await expect(sendMail(message, { deadlineMs: 2_000 })).resolves.toBeUndefined();
  });

  it("zrywa połączenie, gdy serwer stale podtrzymuje odpowiedź, i nie kończy się późnym sukcesem", async () => {
    let finish: () => void = () => undefined;
    const pending = smtpServer((socket) => {
      const drip = setInterval(() => { if (!socket.destroyed) socket.write("250-czekaj\r\n"); }, 20);
      finish = () => { clearInterval(drip); if (!socket.destroyed) socket.write("250 przyjeto\r\n"); };
      setTimeout(finish, 900);
    });
    running = await pending;
    const { state } = await pending;
    const closedBefore = state.closed;
    const started = Date.now();

    const error = await sendMail(message, { deadlineMs: 300 }).then(() => null, (reason: unknown) => reason as { responseCode?: number });

    expect(error).not.toBeNull();
    // Brak kodu odpowiedzi serwera kieruje błąd na ścieżkę ponawiania, a nie trwałego odrzucenia.
    expect(error?.responseCode).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(800);
    await vi.waitFor(() => expect(state.closed).toBe(closedBefore + 1));
  });

  it("nie czeka na serwer, który przyjął połączenie i milczy", async () => {
    const silent = net.createServer((socket) => socket.on("error", () => undefined));
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    mailEnv.SMTP_PORT = (silent.address() as AddressInfo).port;
    running = { server: silent, state: { timers: [] } };
    const started = Date.now();

    await expect(sendMail(message, { deadlineMs: 300 })).rejects.toBeDefined();

    expect(Date.now() - started).toBeLessThan(800);
  });
});
