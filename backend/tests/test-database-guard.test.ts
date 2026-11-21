import { describe, expect, it } from "vitest";
import { assertTestDatabaseUrl, databaseNameOf } from "./integration/test-database.js";

const base = "sqlserver://localhost:1433";

describe("osłona bazy testowej", () => {
  it("przyjmuje dokładnie AprobisTest", () => {
    const url = `${base};database=AprobisTest;integratedSecurity=true;trustServerCertificate=true`;
    expect(assertTestDatabaseUrl(url)).toBe(url);
  });

  it("odmawia bez adresu", () => {
    expect(() => assertTestDatabaseUrl(undefined)).toThrow(/TEST_DATABASE_URL/);
    expect(() => assertTestDatabaseUrl("")).toThrow(/TEST_DATABASE_URL/);
  });

  it("odmawia innej bazy, także kończącej się na Test", () => {
    expect(() => assertTestDatabaseUrl(`${base};database=Aprobis`)).toThrow();
    expect(() => assertTestDatabaseUrl(`${base};database=KsiegowoscTest`)).toThrow();
    expect(() => assertTestDatabaseUrl(`${base};database=AprobisTest2`)).toThrow();
  });

  it("odmawia powtórzonego albo brakującego parametru bazy", () => {
    expect(() => assertTestDatabaseUrl(`${base};database=AprobisTest;database=Aprobis`)).toThrow();
    expect(() => assertTestDatabaseUrl(`${base};database=AprobisTest;initial catalog=Aprobis`)).toThrow();
    expect(() => assertTestDatabaseUrl(`${base};integratedSecurity=true`)).toThrow();
    expect(() => assertTestDatabaseUrl("database=AprobisTest")).toThrow();
  });

  it("czyta nazwę bez względu na wielkość liter klucza", () => {
    expect(databaseNameOf(`${base};Database=AprobisTest`)).toBe("AprobisTest");
  });
});
