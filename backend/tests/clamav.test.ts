import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { interpretClamdReply, scanWithClamd } from "../src/modules/files/clamav.js";
import { scannerMode } from "../src/modules/files/antivirus.js";
import { isFileUsable, usableScanStatuses } from "../src/modules/files/fileAvailability.js";

/** Atrapa clamd: zbiera ramki INSTREAM i odpowiada wg funkcji `reply`. Sprawdza protokół, nie wykrywanie wirusów. */
function fakeClamd(reply: (payload: Buffer) => string | null, options: { splitReply?: boolean } = {}) {
  const received: Buffer[] = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let commandSeen = false;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!commandSeen) {
        const end = buffer.indexOf(0);
        if (end < 0) return;
        expect(buffer.subarray(0, end).toString()).toBe("zINSTREAM");
        buffer = buffer.subarray(end + 1);
        commandSeen = true;
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          const answer = reply(Buffer.concat(received));
          if (answer === null) return; // brak odpowiedzi → timeout klienta
          if (options.splitReply) {
            socket.write(answer.slice(0, 5));
            setTimeout(() => socket.end(`${answer.slice(5)}\0`), 20);
          } else {
            socket.end(`${answer}\0`);
          }
          return;
        }
        if (buffer.length < 4 + length) return;
        received.push(buffer.subarray(4, 4 + length));
        buffer = buffer.subarray(4 + length);
      }
    });
  });
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: (server.address() as net.AddressInfo).port, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

const tmpFiles: string[] = [];
function tempFile(content: Buffer | string) {
  const file = path.join(os.tmpdir(), `aprobis-clamd-${Date.now()}-${Math.random()}.bin`);
  fs.writeFileSync(file, content);
  tmpFiles.push(file);
  return file;
}
afterEach(() => { for (const file of tmpFiles.splice(0)) fs.rmSync(file, { force: true }); });

describe("ClamAV: odpowiedzi clamd", () => {
  it("OK → CLEAN, FOUND → REJECTED, reszta → UNAVAILABLE", () => {
    expect(interpretClamdReply("stream: OK\0").status).toBe("CLEAN");
    expect(interpretClamdReply("stream: Eicar-Test-Signature FOUND\0")).toMatchObject({ status: "REJECTED", message: expect.stringContaining("Eicar") });
    expect(interpretClamdReply("INSTREAM size limit exceeded. ERROR").status).toBe("UNAVAILABLE");
    expect(interpretClamdReply("").status).toBe("UNAVAILABLE");
  });
});

describe("ClamAV: klient INSTREAM", () => {
  it("przesyła cały plik w ramkach i zwraca werdykt", async () => {
    const content = Buffer.alloc(200_000, 7); // kilka ramek po 64 KiB
    const clamd = await fakeClamd((payload) => (payload.equals(content) ? "stream: OK" : "stream: zly-plik FOUND"));
    try {
      expect(await scanWithClamd(tempFile(content), { host: "127.0.0.1", port: clamd.port, timeoutMs: 5000 })).toMatchObject({ status: "CLEAN" });
    } finally { await clamd.close(); }
  });

  it("wykrycie → REJECTED, także przy odpowiedzi w kilku kawałkach", async () => {
    const clamd = await fakeClamd(() => "stream: Test-Signature FOUND", { splitReply: true });
    try {
      expect(await scanWithClamd(tempFile("x"), { host: "127.0.0.1", port: clamd.port, timeoutMs: 5000 })).toMatchObject({ status: "REJECTED" });
    } finally { await clamd.close(); }
  });

  it("brak odpowiedzi, brak serwera i brak pliku → UNAVAILABLE (nigdy CLEAN)", async () => {
    const silent = await fakeClamd(() => null);
    try {
      expect((await scanWithClamd(tempFile("x"), { host: "127.0.0.1", port: silent.port, timeoutMs: 300 })).status).toBe("UNAVAILABLE");
    } finally { await silent.close(); }
    const closed = await fakeClamd(() => "stream: OK");
    const port = closed.port;
    await closed.close();
    expect((await scanWithClamd(tempFile("x"), { host: "127.0.0.1", port, timeoutMs: 2000 })).status).toBe("UNAVAILABLE");
    const clamd = await fakeClamd(() => "stream: OK");
    try {
      expect((await scanWithClamd(path.join(os.tmpdir(), "nie-ma-takiego-pliku.bin"), { host: "127.0.0.1", port: clamd.port, timeoutMs: 2000 })).status).toBe("UNAVAILABLE");
    } finally { await clamd.close(); }
  });
});

describe("tryb skanera i dostępność plików", () => {
  it("bez AV_SCANNER: Defender na Windows, poza Windows brak skanera", () => {
    expect(scannerMode(undefined, "win32")).toBe("defender");
    expect(scannerMode(undefined, "linux")).toBe("unconfigured");
    expect(scannerMode("clamav", "win32")).toBe("clamav");
    expect(scannerMode("disabled", "linux")).toBe("disabled");
  });

  it("NOT_SCANNED jest dostępny tylko przy wyłączonym skanowaniu; REJECTED i PENDING nigdy", () => {
    expect(usableScanStatuses("disabled")).toEqual(["CLEAN", "NOT_SCANNED"]);
    for (const mode of ["defender", "clamav", "unconfigured"] as const) {
      expect(isFileUsable("CLEAN", mode)).toBe(true);
      expect(isFileUsable("NOT_SCANNED", mode)).toBe(false);
    }
    for (const mode of ["defender", "clamav", "unconfigured", "disabled"] as const) {
      expect(isFileUsable("REJECTED", mode)).toBe(false);
      expect(isFileUsable("PENDING", mode)).toBe(false);
    }
  });
});
