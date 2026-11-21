import { describe, expect, it } from "vitest";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "../src/shared/password.js";

describe("hasła", () => {
  it("argon2id: poprawne hasło przechodzi, błędne nie", async () => {
    const hash = await hashPassword("PoprawneHaslo1");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, "PoprawneHaslo1")).toBe(true);
    expect(await verifyPassword(hash, "inne")).toBe(false);
  });

  it("odrzuca skrót w innym formacie niż argon2 (np. bcrypt) i uszkodzony skrót", async () => {
    expect(await verifyPassword("$2b$10$abcdefghijklmnopqrstuuOQ0nAK3I1T0LwFJ6Fh0Wb3c5r1yQ0aS", "cokolwiek")).toBe(false);
    expect(await verifyPassword("czysty-tekst", "czysty-tekst")).toBe(false);
    expect(await verifyPassword("$argon2id$uszkodzony", "cokolwiek")).toBe(false);
  });

  it("porównanie z atrapą nigdy nie daje dostępu", async () => {
    expect(await verifyAgainstDummy("::aprobis-dummy::")).toBe(false);
  });
});
