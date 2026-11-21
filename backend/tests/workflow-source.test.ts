import { describe, expect, it } from "vitest";
import { isAdvancedDefinition, pickDefinition, rulesSourceForType } from "../src/modules/workflow/workflowSource.js";

const type = { id: "t1", code: "WNIOSEK_URLOPOWY", category: "HR" };
const now = new Date("2026-11-20T12:00:00Z");

function rule(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    name: "Reguła",
    priority: 100,
    documentTypeId: null,
    conditionsJson: "{}",
    actionsJson: JSON.stringify({ steps: [{ name: "Kadry", assigneeType: "ROLE", assigneeRole: "HR" }] }),
    validFrom: null,
    validTo: null,
    isActive: true,
    ...overrides
  };
}

describe("pickDefinition — ten sam wybór schematu co w silniku", () => {
  const older = { id: "a", version: 1, updatedAt: new Date(1), steps: [{}] };
  const newer = { id: "b", version: 2, updatedAt: new Date(2), steps: [{}] };

  it("bierze schemat wskazany w typie", () => {
    expect(pickDefinition("a", [newer, older])?.id).toBe("a");
  });

  it("bez wskazania albo gdy wskazany nie ma etapów bierze najnowszą wersję", () => {
    expect(pickDefinition(null, [older, newer])?.id).toBe("b");
    expect(pickDefinition("a", [{ ...older, steps: [] }, newer])?.id).toBe("b");
  });

  it("brak kandydatów to brak schematu", () => {
    expect(pickDefinition("a", [])).toBeNull();
  });
});

describe("rulesSourceForType — reguły, które mogą dotyczyć typu", () => {
  it("bez reguł: wbudowana akceptacja przełożonego", () => {
    expect(rulesSourceForType(type, [], now)).toEqual({ kind: "DEFAULT" });
  });

  it("reguła zależna od kwoty jest potencjalna i zachowuje warunek kwoty", () => {
    const source = rulesSourceForType(type, [rule({ conditionsJson: JSON.stringify({ amountMin: 1000, categories: ["HR"] }) })], now);
    expect(source.kind).toBe("RULES");
    if (source.kind !== "RULES") return;
    expect(source.rules[0].conditions).toEqual({ amountMin: 1000 });
    expect(source.rules[0].steps).toEqual(["Kadry"]);
  });

  it("pomija reguły innego typu, kategorii, wyłączone, przyszłe i wygasłe", () => {
    const rules = [
      rule({ id: "x1", documentTypeId: "inny" }),
      rule({ id: "x2", conditionsJson: JSON.stringify({ categories: ["FINANCIAL"] }) }),
      rule({ id: "x3", conditionsJson: JSON.stringify({ documentTypeCodes: ["FAKTURA"] }) }),
      rule({ id: "x4", isActive: false }),
      rule({ id: "x5", validFrom: new Date("2027-01-01") }),
      rule({ id: "x6", validTo: new Date("2026-01-01") })
    ];
    expect(rulesSourceForType(type, rules, now)).toEqual({ kind: "DEFAULT" });
  });

  it("kolejność według priorytetu i reguła bez etapów też jest pokazana", () => {
    const source = rulesSourceForType(type, [
      rule({ id: "b", name: "B", priority: 20 }),
      rule({ id: "a", name: "A", priority: 10, conditionsJson: JSON.stringify({ keywords: ["pilne"] }), actionsJson: JSON.stringify({ stopProcessing: true }) })
    ], now);
    if (source.kind !== "RULES") throw new Error("oczekiwano RULES");
    expect(source.rules.map((item) => item.id)).toEqual(["a", "b"]);
    expect(source.rules[0]).toMatchObject({ steps: [], stopProcessing: true });
  });

  it("uszkodzone warunki: reguła oznaczona, a reguły za nią nieosiągalne", () => {
    const source = rulesSourceForType(type, [rule({ id: "zla", conditionsJson: "{zły" }), rule({ id: "dalej", priority: 200 })], now);
    if (source.kind !== "RULES") throw new Error("oczekiwano RULES");
    expect(source.rules.map((item) => [item.id, item.broken])).toEqual([["zla", true]]);
  });

  it("uszkodzone akcje reguły kwotowej: ostrzeżenie, nie pewna blokada typu", () => {
    const source = rulesSourceForType(type, [
      rule({ id: "kwota", conditionsJson: JSON.stringify({ amountMin: 1000 }), actionsJson: JSON.stringify({ steps: {} }) }),
      rule({ id: "reszta", priority: 200 })
    ], now);
    if (source.kind !== "RULES") throw new Error("oczekiwano RULES");
    expect(source.rules.map((item) => [item.id, item.broken])).toEqual([["kwota", true], ["reszta", false]]);
  });

  it("bezwarunkowa reguła z zatrzymaniem ukrywa dalsze, nawet uszkodzone (silnik do nich nie dojdzie)", () => {
    const source = rulesSourceForType(type, [
      rule({ id: "stop", priority: 10, actionsJson: JSON.stringify({ stopProcessing: true, steps: [{ name: "Przełożony", assigneeType: "MANAGER" }] }) }),
      rule({ id: "zla", priority: 20, conditionsJson: "{zły" })
    ], now);
    if (source.kind !== "RULES") throw new Error("oczekiwano RULES");
    expect(source.rules.map((item) => item.id)).toEqual(["stop"]);
  });

  it("reguła warunkowa z zatrzymaniem nie ukrywa dalszych", () => {
    const source = rulesSourceForType(type, [
      rule({ id: "stop", priority: 10, conditionsJson: JSON.stringify({ amountMin: 5 }), actionsJson: JSON.stringify({ stopProcessing: true }) }),
      rule({ id: "dalej", priority: 20 })
    ], now);
    if (source.kind !== "RULES") throw new Error("oczekiwano RULES");
    expect(source.rules.map((item) => item.id)).toEqual(["stop", "dalej"]);
  });
});

describe("isAdvancedDefinition — co prosty edytor zachowa w całości", () => {
  const step = { parallelGroup: 1, completionMode: "ALL", assigneeType: "MANAGER", entryConditionJson: null, exitConditionJson: null, assignees: [] as Array<{ assigneeType: string }> };

  it("lista wybranych osób z trybem jedna/wszystkie jest prosta", () => {
    expect(isAdvancedDefinition([{ ...step, assigneeType: "USER", completionMode: "ANY", assignees: [{ assigneeType: "USER", userId: "a" }, { assigneeType: "USER", userId: "b" }] }])).toBe(false);
    expect(isAdvancedDefinition([step, { ...step, assigneeType: "ROLE" }])).toBe(false);
  });

  it("równoległość, kworum, warunki i przypisania innych rodzajów są zaawansowane", () => {
    expect(isAdvancedDefinition([{ ...step, parallelGroup: 2 }])).toBe(true);
    expect(isAdvancedDefinition([{ ...step, assigneeType: "USER", completionMode: "QUORUM", assignees: [{ assigneeType: "USER", userId: "a" }] }])).toBe(true);
    expect(isAdvancedDefinition([{ ...step, completionMode: "ANY" }])).toBe(true);
    expect(isAdvancedDefinition([{ ...step, entryConditionJson: "{}" }])).toBe(true);
    expect(isAdvancedDefinition([{ ...step, assigneeType: "USER", assignees: [{ assigneeType: "ROLE", roleId: "r" }] }])).toBe(true);
    expect(isAdvancedDefinition([{ ...step, assigneeType: "ROLE", assignees: [{ assigneeType: "USER", userId: "u" }] }])).toBe(true);
  });

  it("osoba z grupą (silnik wybierze grupę) albo bez wskazanego konta jest zaawansowana — edytor by ją zgubił", () => {
    expect(isAdvancedDefinition([{ ...step, assigneeType: "USER", assignees: [{ assigneeType: "USER", userId: "u", groupId: "g" }] }])).toBe(true);
    expect(isAdvancedDefinition([{ ...step, assigneeType: "USER", assignees: [{ assigneeType: "USER", userId: null }] }])).toBe(true);
  });
});
