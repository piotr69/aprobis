import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { env } from "../../config/env.js";
import { scanWithClamd } from "./clamav.js";

function findWindowsDefender() {
  const candidates = [
    env.AV_SCANNER_PATH,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Windows Defender", "MpCmdRun.exe") : undefined
  ].filter((candidate): candidate is string => Boolean(candidate));

  const platformRoot = process.env.ProgramData
    ? path.join(process.env.ProgramData, "Microsoft", "Windows Defender", "Platform")
    : undefined;
  if (platformRoot && fs.existsSync(platformRoot)) {
    const versions = fs.readdirSync(platformRoot).sort().reverse();
    for (const version of versions) candidates.unshift(path.join(platformRoot, version, "MpCmdRun.exe"));
  }
  return candidates.find((candidate) => fs.existsSync(candidate));
}

/**
 * NOT_SCANNED: skanowanie świadomie wyłączone (AV_SCANNER=disabled). Nigdy nie oznacza „bezpieczny”.
 * UNAVAILABLE: skaner nie dał werdyktu (błąd, timeout, brak konfiguracji) — worker ponawia, plik czeka.
 */
export type ScanResult = { status: "CLEAN" | "REJECTED" | "UNAVAILABLE" | "NOT_SCANNED"; message: string };

export type ScannerMode = "defender" | "clamav" | "disabled" | "unconfigured";

/** Tryb skanera z AV_SCANNER. Bez wartości: Defender na Windows, poza Windows brak skanera (pliki czekają). */
export function scannerMode(value: string | undefined = env.AV_SCANNER, platform: NodeJS.Platform = process.platform): ScannerMode {
  if (value === "defender" || value === "clamav" || value === "disabled") return value;
  return platform === "win32" ? "defender" : "unconfigured";
}

const SCAN_TIMEOUT_MS = 120_000;
const THREAT_FOUND_EXIT_CODE = 2;

/**
 * Zamienia sposób zakończenia procesu skanera na werdykt.
 *
 * REJECTED jest trwałe — plik nigdy nie stanie się pobieralny i nie ma ścieżki ponowienia,
 * więc rezerwujemy je dla realnego werdyktu skanera (zakończenie kodem != 0).
 * Przerwanie skanera (timeout, sygnał) nie jest werdyktem: zwracamy UNAVAILABLE,
 * które worker ponawia z narastającym opóźnieniem.
 */
export function interpretScanExit(input: {
  timedOut: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}): ScanResult {
  if (input.timedOut) {
    return { status: "UNAVAILABLE", message: `Antivirus scan timed out after ${SCAN_TIMEOUT_MS / 1000}s` };
  }
  if (input.code === null) {
    return { status: "UNAVAILABLE", message: `Antivirus scanner was terminated by signal ${input.signal ?? "unknown"}` };
  }
  if (input.code === 0) {
    return { status: "CLEAN", message: "Antivirus scan completed" };
  }
  // MpCmdRun: 2 = wykryto zagrożenie. Inne kody to błędy samego skanera (np. brak dostępu,
  // nieaktualne sygnatury) i nie mówią nic o pliku — trwałe odrzucenie zablokowałoby czysty plik.
  if (input.code !== THREAT_FOUND_EXIT_CODE) {
    return { status: "UNAVAILABLE", message: `Antivirus scanner exited with code ${input.code}` };
  }
  return {
    status: "REJECTED",
    message: input.output.trim().slice(-500) || `Antivirus scanner exited with code ${input.code}`
  };
}

export async function scanFile(filePath: string, mode: ScannerMode = scannerMode()): Promise<ScanResult> {
  switch (mode) {
    case "disabled":
      return { status: "NOT_SCANNED", message: "Skanowanie antywirusowe wyłączone (AV_SCANNER=disabled)" };
    case "unconfigured":
      return { status: "UNAVAILABLE", message: "Brak skanera antywirusowego: ustaw AV_SCANNER (defender, clamav albo disabled)" };
    case "clamav":
      return scanWithClamd(filePath, { host: env.CLAMAV_HOST, port: env.CLAMAV_PORT, timeoutMs: SCAN_TIMEOUT_MS });
    case "defender":
      return scanWithDefender(filePath);
  }
}

async function scanWithDefender(filePath: string): Promise<ScanResult> {
  if (process.platform !== "win32") {
    return { status: "UNAVAILABLE", message: "Windows Defender działa tylko na Windows: ustaw AV_SCANNER=clamav albo disabled" };
  }
  const executable = findWindowsDefender();
  if (!executable) return { status: "UNAVAILABLE", message: "Windows Defender command-line scanner was not found" };

  return new Promise((resolve) => {
    const child = spawn(executable, ["-Scan", "-ScanType", "3", "-File", filePath, "-DisableRemediation"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, SCAN_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ status: "UNAVAILABLE", message: error.message.slice(0, 500) });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve(interpretScanExit({ timedOut, code, signal, output }));
    });
  });
}
