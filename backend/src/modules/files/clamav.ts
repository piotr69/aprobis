import fs from "node:fs";
import net from "node:net";

/**
 * Klient clamd (protokół INSTREAM): plik idzie strumieniem w ramkach [długość uint32 BE][dane],
 * zakończenie ramką zerowej długości. Odpowiedź: "stream: OK", "stream: <nazwa> FOUND" albo "... ERROR".
 * https://docs.clamav.net/manual/Usage/ClamdProtocol.html
 */
export type ClamdVerdict =
  | { status: "CLEAN"; message: string }
  | { status: "REJECTED"; message: string }
  | { status: "UNAVAILABLE"; message: string };

const CHUNK_SIZE = 64 * 1024;
const MAX_REPLY_BYTES = 4096;

/** Odpowiedź clamd → werdykt. Wszystko poza jednoznacznym OK/FOUND to błąd skanera, nie werdykt o pliku. */
export function interpretClamdReply(raw: string): ClamdVerdict {
  const reply = raw.replace(/\0/g, "").trim();
  if (/^stream: OK$/i.test(reply)) return { status: "CLEAN", message: "ClamAV: brak zagrożeń" };
  const found = /^stream: (.+) FOUND$/i.exec(reply);
  if (found) return { status: "REJECTED", message: `ClamAV: wykryto ${found[1]}`.slice(0, 500) };
  return { status: "UNAVAILABLE", message: `ClamAV: ${reply || "pusta odpowiedź"}`.slice(0, 500) };
}

export function scanWithClamd(filePath: string, options: { host: string; port: number; timeoutMs: number }): Promise<ClamdVerdict> {
  return new Promise((resolve) => {
    let settled = false;
    let reply = "";
    const socket = net.createConnection({ host: options.host, port: options.port });
    const stream = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE });

    const finish = (verdict: ClamdVerdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.destroy();
      socket.destroy();
      resolve(verdict);
    };
    const timer = setTimeout(() => finish({ status: "UNAVAILABLE", message: `ClamAV: brak odpowiedzi po ${options.timeoutMs / 1000}s` }), options.timeoutMs);

    socket.on("error", (error) => finish({ status: "UNAVAILABLE", message: `ClamAV: ${error.message}`.slice(0, 500) }));
    stream.on("error", (error) => finish({ status: "UNAVAILABLE", message: `ClamAV: nie można odczytać pliku (${error.message})`.slice(0, 500) }));

    socket.on("data", (chunk) => {
      reply += chunk.toString("utf8");
      if (Buffer.byteLength(reply) > MAX_REPLY_BYTES) finish({ status: "UNAVAILABLE", message: "ClamAV: zbyt długa odpowiedź" });
      // clamd w trybie "z" kończy odpowiedź znakiem NUL.
      if (reply.includes("\0")) finish(interpretClamdReply(reply));
    });
    socket.on("end", () => finish(interpretClamdReply(reply)));

    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      stream.on("data", (data) => {
        const chunk = typeof data === "string" ? Buffer.from(data) : data;
        const header = Buffer.alloc(4);
        header.writeUInt32BE(chunk.length, 0);
        // Backpressure: wstrzymaj czytanie pliku, gdy bufor gniazda jest pełny.
        if (!socket.write(Buffer.concat([header, chunk]))) {
          stream.pause();
          socket.once("drain", () => stream.resume());
        }
      });
      stream.on("end", () => socket.write(Buffer.alloc(4)));
    });
  });
}
