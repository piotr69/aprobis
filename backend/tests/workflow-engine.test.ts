import { describe, expect, it } from "vitest";
import { matchesRuleConditions } from "../src/modules/workflow/ruleMatcher.js";
import { isStageComplete } from "../src/modules/workflow/workflow.engine.js";

const baseDocument = {
  amount: "3200",
  currency: "PLN",
  title: "Faktura za licencja IT",
  location: "Warszawa",
  type: {
    code: "FAKTURA_KOSZTOWA",
    category: "FINANCIAL"
  },
  department: {
    code: "PROD"
  }
} as never;

describe("matchesRuleConditions", () => {
  it("matches invoice below 5 000 PLN", () => {
    expect(
      matchesRuleConditions(
        { documentTypeCodes: ["FAKTURA_KOSZTOWA"], amountMax: 5000, currency: "PLN" },
        baseDocument
      )
    ).toBe(true);
  });

  it("does not match high-value invoice rule for small invoice", () => {
    expect(
      matchesRuleConditions(
        { documentTypeCodes: ["FAKTURA_KOSZTOWA"], amountMin: 50000, currency: "PLN" },
        baseDocument
      )
    ).toBe(false);
  });

  it("matches legal rule by category for contracts", () => {
    expect(
      matchesRuleConditions(
        { categories: ["CONTRACT"] },
        {
          ...baseDocument,
          amount: null,
          type: { code: "UMOWA_KONTRAHENT", category: "CONTRACT" }
        } as never
      )
    ).toBe(true);
  });

  it("matches IT purchase by keyword", () => {
    expect(
      matchesRuleConditions(
        { documentTypeCodes: ["FAKTURA_KOSZTOWA"], keywords: ["licencja", "software"] },
        baseDocument
      )
    ).toBe(true);
  });
});

describe("parallel stage completion", () => {
  it("ALL waits for every task", () => {
    expect(isStageComplete("ALL", 2, ["COMPLETED", "OPEN"])).toBe(false);
    expect(isStageComplete("ALL", 2, ["COMPLETED", "COMPLETED"])).toBe(true);
  });

  it("ANY completes after the first approval", () => {
    expect(isStageComplete("ANY", 1, ["COMPLETED", "OPEN", "OPEN"])).toBe(true);
  });

  it("QUORUM uses requiredApprovals", () => {
    expect(isStageComplete("QUORUM", 2, ["COMPLETED", "OPEN", "OPEN"])).toBe(false);
    expect(isStageComplete("QUORUM", 2, ["COMPLETED", "COMPLETED", "OPEN"])).toBe(true);
  });
});
