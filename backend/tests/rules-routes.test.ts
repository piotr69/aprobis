import { describe, expect, it } from "vitest";
import { assertValidJson } from "../src/modules/rules/rules.routes.js";
import { AppError } from "../src/shared/http.js";

describe("assertValidJson", () => {
  it("przepuszcza poprawny JSON", () => {
    expect(() => assertValidJson('{"amountMax":5000}', "conditionsJson")).not.toThrow();
  });

  it("pomija pole nieprzysłane w żądaniu", () => {
    expect(() => assertValidJson(undefined, "conditionsJson")).not.toThrow();
  });

  it("zgłasza 400, a nie 500, dla uszkodzonego JSON-a", () => {
    // Gołe JSON.parse rzucało SyntaxError, którego errorHandler nie rozpoznaje
    // i raportuje jako „Internal server error".
    try {
      assertValidJson('{"amountMax":5000,}', "conditionsJson");
      expect.unreachable("powinno rzucić");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).statusCode).toBe(400);
      expect((error as AppError).message).toContain("conditionsJson");
    }
  });

  it("wskazuje pole, którego dotyczy błąd", () => {
    try {
      assertValidJson("###", "actionsJson");
      expect.unreachable("powinno rzucić");
    } catch (error) {
      expect((error as AppError).details).toMatchObject({ issues: [{ field: "actionsJson" }] });
    }
  });
});
