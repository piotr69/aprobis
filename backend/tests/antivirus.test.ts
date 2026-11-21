import { describe, expect, it } from "vitest";
import { interpretScanExit } from "../src/modules/files/antivirus.js";

const base = { timedOut: false, code: 0, signal: null, output: "" };

describe("interpretScanExit", () => {
  it("uznaje kod 0 za plik czysty", () => {
    expect(interpretScanExit(base)).toEqual({ status: "CLEAN", message: "Antivirus scan completed" });
  });

  it("uznaje kod != 0 za werdykt odrzucający i zachowuje komunikat skanera", () => {
    const result = interpretScanExit({ ...base, code: 2, output: "  Threat detected: EICAR_Test_File  " });
    expect(result.status).toBe("REJECTED");
    expect(result.message).toBe("Threat detected: EICAR_Test_File");
  });

  it("podaje kod wyjścia, gdy skaner nic nie wypisał", () => {
    expect(interpretScanExit({ ...base, code: 2 })).toEqual({
      status: "REJECTED",
      message: "Antivirus scanner exited with code 2"
    });
  });

  it("błąd samego skanera nie jest werdyktem o pliku", () => {
    // Trwałe REJECTED przy np. nieaktualnych sygnaturach zablokowałoby czysty plik.
    expect(interpretScanExit({ ...base, code: 5 }).status).toBe("UNAVAILABLE");
  });

  it("po timeoucie zwraca UNAVAILABLE, a nie REJECTED", () => {
    // Kluczowe: zabity proces raportuje code=null, co dawniej wpadało w gałąź REJECTED
    // i trwale blokowało czysty plik (423 przy pobieraniu, brak ponowienia).
    const result = interpretScanExit({ timedOut: true, code: null, signal: "SIGTERM", output: "" });
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.message).toContain("timed out");
  });

  it("timeout ma pierwszeństwo, nawet jeśli proces zdążył zwrócić kod", () => {
    expect(interpretScanExit({ timedOut: true, code: 1, signal: null, output: "cokolwiek" }).status).toBe("UNAVAILABLE");
  });

  it("zabicie sygnałem z zewnątrz też jest UNAVAILABLE", () => {
    const result = interpretScanExit({ ...base, code: null, signal: "SIGKILL" });
    expect(result).toEqual({ status: "UNAVAILABLE", message: "Antivirus scanner was terminated by signal SIGKILL" });
  });

  it("przycina bardzo długie wyjście skanera do 500 znaków", () => {
    const result = interpretScanExit({ ...base, code: 2, output: "x".repeat(2000) });
    expect(result.message).toHaveLength(500);
  });
});
