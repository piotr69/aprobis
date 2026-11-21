import { scannerMode, type ScannerMode } from "./antivirus.js";

/**
 * Kiedy załącznik wolno pobrać i liczyć jako dołączony: po czystym skanie, a plik nieskanowany
 * (NOT_SCANNED) tylko wtedy, gdy skanowanie jest świadomie wyłączone. Po włączeniu skanera
 * takie pliki wracają do kolejki (requeueNotScannedFiles) i czekają na werdykt.
 */
export function usableScanStatuses(mode: ScannerMode = scannerMode()): string[] {
  return mode === "disabled" ? ["CLEAN", "NOT_SCANNED"] : ["CLEAN"];
}

export function isFileUsable(scanStatus: string, mode: ScannerMode = scannerMode()) {
  return usableScanStatuses(mode).includes(scanStatus);
}
