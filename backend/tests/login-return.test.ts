import { describe, expect, it } from "vitest";
import { loginPathFrom, safeReturnPath } from "../../frontend/lib/loginReturn";

describe("powrót po logowaniu", () => {
  it("wraca tylko na kartę dokumentu", () => {
    expect(safeReturnPath("/documents/cm123_abc-X")).toBe("/documents/cm123_abc-X");
    expect(loginPathFrom("/documents/abc")).toBe("/login?next=%2Fdocuments%2Fabc");
  });

  it.each([
    null,
    "",
    "/",
    "/admin/users",
    "/documents/",
    "/documents/new/../../admin",
    "/documents/abc?x=1",
    "//evil.example",
    "/\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/documents/abc\n",
    "/documents/abc\t",
    "https://evil.example/documents/abc",
    "%2F%2Fevil.example",
    "/documents/%2F%2Fevil.example"
  ])("odrzuca %j", (value) => {
    expect(safeReturnPath(value)).toBeNull();
  });

  it("zwykłe strony nie dostają parametru", () => {
    expect(loginPathFrom("/admin/users")).toBe("/login");
  });

  it("zakodowany cel po jednokrotnym odkodowaniu też jest odrzucany", () => {
    const decoded = new URLSearchParams("next=%2F%09%2Fevil.example").get("next");
    expect(decoded).toBe("/\t/evil.example");
    expect(safeReturnPath(decoded)).toBeNull();
  });
});
