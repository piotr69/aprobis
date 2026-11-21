import { describe, expect, it } from "vitest";
import {
  collectAttachmentIssues,
  normalizeDocumentData,
  validateConfiguredFields,
  type ConfiguredDocumentField,
  type DocumentValidationRule
} from "../src/modules/document-types/document-config.service.js";
import { resolveTypeVersionUpdate } from "../src/modules/documents/document.service.js";

const fields: ConfiguredDocumentField[] = [
  { key: "invoice_number", label: "Numer faktury", type: "text", required: true, searchable: true },
  { key: "payment_days", label: "Termin płatności", type: "number", required: false, searchable: true },
  { key: "cost_kind", label: "Rodzaj kosztu", type: "select", required: false, searchable: false, options: ["CAPEX", "OPEX"] }
];

describe("reguły walidacji", () => {
  const withId: ConfiguredDocumentField[] = [
    { id: "field-1", key: "invoice_number", label: "Numer faktury", type: "text", required: false, searchable: false }
  ];
  const rule = (overrides: Partial<DocumentValidationRule>): DocumentValidationRule => ({
    fieldDefinitionId: null,
    status: null,
    ruleType: "MIN_LENGTH",
    configJson: "{}",
    message: null,
    ...overrides
  });

  it("stosuje regułę przypiętą do konkretnego pola", () => {
    const rules = [rule({ fieldDefinitionId: "field-1", ruleType: "MIN_LENGTH", configJson: JSON.stringify({ value: 5 }) })];
    expect(() => validateConfiguredFields(withId, { invoice_number: "FV/1" }, "DRAFT", rules)).toThrow(/Popraw dane/);
    expect(() => validateConfiguredFields(withId, { invoice_number: "FV/12345" }, "DRAFT", rules)).not.toThrow();
  });

  it("uruchamia regułę na poziomie typu wskazującą pole przez configJson.field", () => {
    // Wcześniej reguły z fieldDefinitionId === null nie trafiały w żadne pole
    // (undefined === null jest fałszem) i były po cichu pomijane.
    const rules = [rule({ ruleType: "MIN_LENGTH", configJson: JSON.stringify({ field: "invoice_number", value: 5 }) })];
    expect(() => validateConfiguredFields(withId, { invoice_number: "FV/1" }, "DRAFT", rules)).toThrow(/Popraw dane/);
  });

  it("regułą na poziomie typu można walidować wbudowane atrybuty dokumentu", () => {
    const rules = [rule({ ruleType: "MIN", configJson: JSON.stringify({ field: "amount", value: 100 }), message: "Kwota za niska" })];
    expect(() => validateConfiguredFields([], {}, "SUBMIT", rules, { amount: "50" })).toThrow(/Popraw dane/);
    expect(() => validateConfiguredFields([], {}, "SUBMIT", rules, { amount: "500" })).not.toThrow();
  });

  it("pomija regułę na poziomie typu bez wskazanego pola, zamiast wywalać żądanie", () => {
    const rules = [rule({ ruleType: "MIN_LENGTH", configJson: JSON.stringify({ value: 5 }) })];
    expect(() => validateConfiguredFields(withId, { invoice_number: "FV/1" }, "DRAFT", rules)).not.toThrow();
  });

  it("respektuje fazę reguły", () => {
    const rules = [rule({ ruleType: "MIN_LENGTH", configJson: JSON.stringify({ field: "invoice_number", value: 5 }), status: "SUBMIT" })];
    expect(() => validateConfiguredFields(withId, { invoice_number: "FV/1" }, "DRAFT", rules)).not.toThrow();
    expect(() => validateConfiguredFields(withId, { invoice_number: "FV/1" }, "SUBMIT", rules)).toThrow(/Popraw dane/);
  });

  it("uszkodzony wzorzec REGEX odrzuca wartość, zamiast rzucać wyjątkiem", () => {
    const rules = [rule({ fieldDefinitionId: "field-1", ruleType: "REGEX", configJson: JSON.stringify({ pattern: "[niedomkniete" }) })];
    expect(() => validateConfiguredFields(withId, { invoice_number: "FV/1" }, "DRAFT", rules)).toThrow(/Popraw dane/);
  });
});

describe("collectAttachmentIssues", () => {
  const required = { status: null, minCount: 1, label: "Faktura źródłowa" };

  it("zgłasza brak załącznika", () => {
    expect(collectAttachmentIssues([required], 0, "SUBMIT")).toEqual([
      { field: "attachments", message: "Wymagany załącznik: Faktura źródłowa" }
    ]);
  });

  it("milczy, gdy załączników jest dość", () => {
    expect(collectAttachmentIssues([required], 1, "SUBMIT")).toEqual([]);
  });

  it("pomija wymaganie przypisane do innej fazy", () => {
    // Wcześniej `status` był ignorowany i wymaganie z fazy DRAFT blokowało wysyłkę.
    expect(collectAttachmentIssues([{ ...required, status: "DRAFT" }], 0, "SUBMIT")).toEqual([]);
  });

  it("stosuje wymaganie przypisane do bieżącej fazy", () => {
    expect(collectAttachmentIssues([{ ...required, status: "SUBMIT" }], 0, "SUBMIT")).toHaveLength(1);
  });

  it("wymaganie bez fazy obowiązuje zawsze", () => {
    expect(collectAttachmentIssues([required], 0, "DRAFT")).toHaveLength(1);
  });

  it("zlicza wiele braków naraz", () => {
    const requirements = [required, { status: null, minCount: 3, label: "Protokół odbioru" }];
    expect(collectAttachmentIssues(requirements, 0, "SUBMIT")).toHaveLength(2);
  });
});

describe("resolveTypeVersionUpdate", () => {
  it("nie rusza kolumny, gdy typ dokumentu się nie zmienia", () => {
    expect(resolveTypeVersionUpdate(false, undefined)).toBeUndefined();
    expect(resolveTypeVersionUpdate(false, "version-1")).toBeUndefined();
  });

  it("przestawia wersję na wersję nowego typu", () => {
    expect(resolveTypeVersionUpdate(true, "version-2")).toBe("version-2");
  });

  it("czyści wersję, gdy nowy typ nie ma opublikowanej wersji", () => {
    // undefined oznaczałoby dla Prismy „zostaw jak było" — dokument zachowałby
    // wersję poprzedniego typu i renderował jego pola.
    expect(resolveTypeVersionUpdate(true, undefined)).toBeNull();
  });
});

describe("configured document fields", () => {
  it("normalizes legacy label keys to stable keys", () => {
    expect(normalizeDocumentData(fields, { "Numer faktury": "FV/1" })).toEqual({ invoice_number: "FV/1" });
  });

  it("allows an incomplete draft but rejects an incomplete submit", () => {
    expect(() => validateConfiguredFields(fields, {}, "DRAFT")).not.toThrow();
    expect(() => validateConfiguredFields(fields, {}, "SUBMIT")).toThrow(/Popraw dane/);
  });

  it("checks field types and select options", () => {
    expect(() => validateConfiguredFields(fields, { invoice_number: "FV/1", payment_days: "abc" }, "SUBMIT")).toThrow();
    expect(() => validateConfiguredFields(fields, { invoice_number: "FV/1", cost_kind: "OTHER" }, "SUBMIT")).toThrow();
  });
});
