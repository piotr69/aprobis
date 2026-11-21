import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/shared/prisma.js";

/**
 * Klient HTTP pojedynczego użytkownika: pamięta cookie sesji jak przeglądarka.
 * Testy integracyjne idą przez prawdziwe API, bo większość błędów obiegu powstaje
 * na styku routera, uprawnień i silnika, a nie w pojedynczej funkcji.
 */
export class Client {
  private cookie = "";
  constructor(private readonly baseUrl: string) {}

  async request<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const isForm = body instanceof FormData;
    const response = await fetch(`${this.baseUrl}/api${path}`, {
      method,
      headers: {
        ...(body === undefined || isForm ? {} : { "Content-Type": "application/json" }),
        ...(this.cookie ? { Cookie: this.cookie } : {})
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body)
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0];
    const text = await response.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { /* zostaje tekst */ }
    return { status: response.status, body: parsed as T };
  }

  get<T = any>(path: string) { return this.request<T>("GET", path); }
  post<T = any>(path: string, body: unknown = {}) { return this.request<T>("POST", path, body); }
  patch<T = any>(path: string, body: unknown = {}) { return this.request<T>("PATCH", path, body); }
  delete<T = any>(path: string) { return this.request<T>("DELETE", path); }
}

export const passwords = {
  admin: "Admin#2026",
  marek: "Marek#2026",
  ewa: "Ewa#2026",
  piotr: "Piotr#2026",
  anna: "Anna#2026",
  jan: "Jan#2026",
  maria: "Maria#2026",
  tomasz: "Prawny#2026",
  olga: "Zakupy#2026",
  adam: "IT#2026!!",
  karolina: "HR#2026!!",
  sekretariat: "Sekretariat#2026",
  audytor: "Audytor#2026"
} as const;

export type Who = keyof typeof passwords;

export const emails: Record<Who, string> = {
  admin: "admin@aprobis.local",
  marek: "marek.prezes@aprobis.local",
  ewa: "ewa.zarzad@aprobis.local",
  piotr: "piotr.dyrektor@aprobis.local",
  anna: "anna.kierownik@aprobis.local",
  jan: "jan.pracownik@aprobis.local",
  maria: "maria.ksiegowosc@aprobis.local",
  tomasz: "tomasz.prawny@aprobis.local",
  olga: "olga.zakupy@aprobis.local",
  adam: "adam.it@aprobis.local",
  karolina: "karolina.hr@aprobis.local",
  sekretariat: "sekretariat@aprobis.local",
  audytor: "audytor@aprobis.local"
};

export type TestServer = { baseUrl: string; close: () => Promise<void> };

export async function startServer(): Promise<TestServer> {
  const server: Server = await new Promise((resolve) => {
    const listening = createApp().listen(0, "127.0.0.1", () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}

export async function login(baseUrl: string, who: Who, password: string = passwords[who]) {
  // Limit prób logowania liczy się per adres, a testy logują wiele osób z jednego.
  await prisma.rateLimitBucket.deleteMany();
  const client = new Client(baseUrl);
  const result = await client.post("/auth/login", { identifier: emails[who], password });
  if (result.status !== 200) throw new Error(`Logowanie ${who} nieudane: ${result.status} ${JSON.stringify(result.body)}`);
  return client;
}

export async function typeId(client: Client, code: string) {
  const { body } = await client.get("/document-types");
  return body.find((type: any) => type.code === code).id as string;
}

export async function draftInvoice(client: Client, amount: string, currency = "PLN") {
  const created = await client.post("/documents", {
    title: `Faktura testowa ${amount} ${currency}`,
    typeId: await typeId(client, "FAKTURA_KOSZTOWA"),
    amount,
    currency,
    contractorName: "Kontrahent Sp. z o.o.",
    data: { invoiceNumber: "FV/1", paymentDueAt: "2026-12-31" }
  });
  if (created.status !== 201) throw new Error(`Nie utworzono dokumentu: ${JSON.stringify(created.body)}`);
  return created.body as { id: string; version: number; number: string };
}

export async function submittedInvoice(client: Client, amount: string, currency = "PLN") {
  const document = await draftInvoice(client, amount, currency);
  const submitted = await client.post(`/documents/${document.id}/submit`);
  if (submitted.status !== 201) throw new Error(`Nie złożono dokumentu: ${JSON.stringify(submitted.body)}`);
  return document;
}

export async function openTaskFor(client: Client, documentId: string) {
  const { body } = await client.get("/workflow/tasks/my");
  return body.find((task: any) => task.documentId === documentId);
}

export function decide(client: Client, task: { id: string; version: number }, decision: "APPROVE" | "REJECT" | "RETURN", comment?: string) {
  return client.post(`/workflow/tasks/${task.id}/decision`, { decision, comment, expectedVersion: task.version });
}

export async function userId(email: string) {
  return (await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id;
}

export { prisma };
