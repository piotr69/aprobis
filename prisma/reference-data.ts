/** Dane potrzebne każdej instalacji: role i typy dokumentów. Korzystają z nich seed i start produkcji. */
export const DocumentCategory = {
  FINANCIAL: "FINANCIAL",
  CONTRACT: "CONTRACT",
  HR: "HR",
  ADMIN: "ADMIN",
  TECHNICAL: "TECHNICAL",
  QUALITY: "QUALITY"
} as const;

// Rola decyduje o widoczności i modułach (backend/src/shared/roles.ts); prawo do decyzji
// wynika z przypisania zadania. Tu zakładamy tylko rekordy ról wymagane przy tworzeniu kont.
export const seededRoles = [
  "SYSTEM_ADMIN", "DICTIONARY_ADMIN", "EMPLOYEE", "DEPARTMENT_MANAGER", "HR", "ACCOUNTING",
  "DIRECTOR", "BOARD", "LEGAL", "PURCHASING", "IT", "AUDITOR", "VIEWER", "SECRETARIAT"
];

export const documentTypes = [
  ["Faktura kosztowa", "FAKTURA_KOSZTOWA", DocumentCategory.FINANCIAL, true, true],
  ["Faktura zakupowa", "FAKTURA_ZAKUPOWA", DocumentCategory.FINANCIAL, true, true],
  ["Faktura sprzedażowa", "FAKTURA_SPRZEDAZOWA", DocumentCategory.FINANCIAL, true, true],
  ["Nota księgowa", "NOTA_KSIEGOWA", DocumentCategory.FINANCIAL, true, true],
  ["Wniosek o płatność", "WNIOSEK_PLATNOSC", DocumentCategory.FINANCIAL, true, true],
  ["Delegacja", "DELEGACJA", DocumentCategory.FINANCIAL, true, false],
  ["Rozliczenie zaliczki", "ROZLICZENIE_ZALICZKI", DocumentCategory.FINANCIAL, true, false],
  ["Zamówienie zakupu", "ZAMOWIENIE_ZAKUPU", DocumentCategory.FINANCIAL, true, true],
  ["Zapotrzebowanie zakupowe", "ZAPOTRZEBOWANIE", DocumentCategory.FINANCIAL, true, false],
  ["Wniosek inwestycyjny CAPEX", "CAPEX", DocumentCategory.FINANCIAL, true, false],
  ["Budżet / korekta budżetu", "BUDZET_KOREKTA", DocumentCategory.FINANCIAL, true, false],
  ["Umowa z kontrahentem", "UMOWA_KONTRAHENT", DocumentCategory.CONTRACT, false, true],
  ["Aneks do umowy", "ANEKS_UMOWY", DocumentCategory.CONTRACT, false, true],
  ["Wypowiedzenie umowy", "WYPOWIEDZENIE_UMOWY", DocumentCategory.CONTRACT, false, true],
  ["NDA / umowa o poufności", "NDA", DocumentCategory.CONTRACT, false, true],
  ["Umowa ramowa", "UMOWA_RAMOWA", DocumentCategory.CONTRACT, false, true],
  ["Zamówienie do umowy", "ZAMOWIENIE_DO_UMOWY", DocumentCategory.CONTRACT, true, true],
  ["Wniosek urlopowy", "WNIOSEK_URLOPOWY", DocumentCategory.HR, false, false],
  ["Wniosek o pracę zdalną", "PRACA_ZDALNA", DocumentCategory.HR, false, false],
  ["Wniosek o nadgodziny", "NADGODZINY", DocumentCategory.HR, false, false],
  ["Wniosek o zatrudnienie", "WNIOSEK_ZATRUDNIENIE", DocumentCategory.HR, false, false],
  ["Wniosek o zmianę warunków zatrudnienia", "ZMIANA_WARUNKOW", DocumentCategory.HR, false, false],
  ["Dokument kadrowy do akceptacji", "DOKUMENT_KADROWY", DocumentCategory.HR, false, false],
  ["Pismo przychodzące", "PISMO_PRZYCHODZACE", DocumentCategory.ADMIN, false, false],
  ["Pismo wychodzące", "PISMO_WYCHODZACE", DocumentCategory.ADMIN, false, false],
  ["Decyzja wewnętrzna", "DECYZJA_WEWNETRZNA", DocumentCategory.ADMIN, false, false],
  ["Zarządzenie", "ZARZADZENIE", DocumentCategory.ADMIN, false, false],
  ["Protokół", "PROTOKOL", DocumentCategory.ADMIN, false, false],
  ["Notatka służbowa", "NOTATKA_SLUZBOWA", DocumentCategory.ADMIN, false, false],
  ["Dokument do wiadomości", "DOKUMENT_DO_WIADOMOSCI", DocumentCategory.ADMIN, false, false],
  ["Zgłoszenie techniczne", "ZGLOSZENIE_TECHNICZNE", DocumentCategory.TECHNICAL, false, false],
  ["Wniosek o zakup części technicznych", "ZAKUP_CZESCI_TECH", DocumentCategory.TECHNICAL, true, false],
  ["Protokół odbioru", "PROTOKOL_ODBIORU", DocumentCategory.TECHNICAL, false, true],
  ["Dokumentacja techniczna", "DOKUMENTACJA_TECH", DocumentCategory.TECHNICAL, false, false],
  ["Zmiana technologiczna", "ZMIANA_TECHNOLOGICZNA", DocumentCategory.TECHNICAL, false, false],
  ["Wniosek o inwestycję techniczną", "INWESTYCJA_TECH", DocumentCategory.TECHNICAL, true, false],
  ["Reklamacja", "REKLAMACJA", DocumentCategory.QUALITY, false, true],
  ["Niezgodność", "NIEZGODNOSC", DocumentCategory.QUALITY, false, false],
  ["Działanie korygujące", "DZIALANIE_KORYGUJACE", DocumentCategory.QUALITY, false, false],
  ["Audyt wewnętrzny", "AUDYT_WEWNETRZNY", DocumentCategory.QUALITY, false, false],
  ["Dokument RODO", "RODO", DocumentCategory.QUALITY, false, false],
  ["Dokument BHP", "BHP", DocumentCategory.QUALITY, false, false],
  ["Procedura / instrukcja", "PROCEDURA", DocumentCategory.QUALITY, false, false]
] as const;

// Definicje pól formularza per typ dokumentu (klucz = label, trafia do metadataJson).
export type SeedField = {
  key: string;
  label: string;
  type: "text" | "number" | "date" | "select" | "textarea";
  required?: boolean;
  options?: string[];
  placeholder?: string;
};

const invoiceFields: SeedField[] = [
  { key: "invoiceNumber", label: "Numer faktury", type: "text", required: true, placeholder: "FV/2026/..." },
  { key: "paymentDueAt", label: "Termin płatności", type: "date", required: true },
  { key: "costCenter", label: "Centrum kosztów", type: "text", placeholder: "np. PROD-01" },
  { key: "invoiceDescription", label: "Opis kosztu", type: "text", placeholder: "Krótki opis czego dotyczy faktura" }
];

export const documentTypeFields: Record<string, { fields: SeedField[]; titleTemplate?: string }> = {
  WNIOSEK_URLOPOWY: {
    titleTemplate: "Wniosek urlopowy {vacationStart} - {vacationEnd}",
    fields: [
      { key: "vacationKind", label: "Rodzaj urlopu", type: "select", required: true, options: ["Wypoczynkowy", "Na żądanie", "Okolicznościowy", "Bezpłatny"] },
      { key: "vacationStart", label: "Od", type: "date", required: true },
      { key: "vacationEnd", label: "Do", type: "date", required: true },
      { key: "vacationDays", label: "Liczba dni", type: "number", required: true, placeholder: "np. 5" },
      { key: "substitute", label: "Zastępca", type: "text", required: true, placeholder: "Osoba przejmująca obowiązki" },
      { key: "reason", label: "Uzasadnienie", type: "textarea", placeholder: "Opcjonalny komentarz do wniosku" }
    ]
  },
  FAKTURA_KOSZTOWA: { fields: invoiceFields },
  FAKTURA_ZAKUPOWA: { fields: invoiceFields }
};
