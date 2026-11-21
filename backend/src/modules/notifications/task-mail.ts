import type { OutboxMessage } from "@prisma/client";
import { env } from "../../config/env.js";
import { DocumentStatus, WorkflowTaskStatus } from "../../shared/domain.js";
import { logger } from "../../shared/logger.js";
import { getSmtpSettings, sendMail } from "../../shared/mailer.js";
import { prisma } from "../../shared/prisma.js";
import { taskRecipients } from "../workflow/workflow.engine.js";

/** Łączna liczba prób wysyłki jednego maila; przy odstępach 5–60 min to około 6,5 godziny. */
export const TASK_MAIL_MAX_ATTEMPTS = 12;

/** Treść zapisuje `notifyTaskOpened` w silniku obiegu. */
type TaskMailPayload = { userId: string; documentId: string; taskId: string; taskVersion: number };

/**
 * Mail wychodzi poza program, więc celowo nie zawiera tytułu, typu, autora ani pól dokumentu.
 * Link nie daje dostępu sam z siebie: wymaga logowania i uprawnień w aplikacji.
 */
export function taskMailContent(input: { number: string; dueAt: Date | null; url: string }) {
  const due = input.dueAt ? `Termin decyzji: ${input.dueAt.toLocaleDateString("pl-PL")}\n` : "";
  return {
    subject: `Aprobis: czeka na Twoją decyzję (${input.number})`,
    text: `Dzień dobry,\n\nw programie Aprobis czeka na Twoją decyzję dokument ${input.number}.\n${due}\nOtwórz dokument:\n${input.url}\n\nWiadomość wysłano automatycznie. Prosimy na nią nie odpowiadać.`
  };
}

export function close(messageId: string, lastError: string | null = null) {
  return prisma.outboxMessage.update({
    where: { id: messageId },
    data: { processedAt: new Date(), lastError, lockedAt: null, lockedBy: null }
  });
}

function parsePayload(json: string): TaskMailPayload | null {
  try {
    const value = JSON.parse(json) as Partial<TaskMailPayload>;
    return value.userId && value.documentId && value.taskId && typeof value.taskVersion === "number" ? (value as TaskMailPayload) : null;
  } catch {
    return null;
  }
}

/** Adres e-mail odbiorcy, jeżeli ten komunikat nadal dotyczy aktualnego przydziału tej osoby. */
async function currentDelivery(payload: TaskMailPayload) {
  const task = await prisma.workflowTask.findUnique({
    where: { id: payload.taskId },
    select: { status: true, version: true, dueAt: true, documentId: true, document: { select: { number: true, status: true, authorId: true } } }
  });
  // Inna wersja to nowe przypisanie (także A→B→A), a ono ma własny komunikat.
  if (!task || task.documentId !== payload.documentId || task.status !== WorkflowTaskStatus.OPEN || task.version !== payload.taskVersion) return null;
  if (task.document.status !== DocumentStatus.IN_APPROVAL) return null;
  // Rola, grupa i zastępstwo mogły się zmienić od przydzielenia zadania.
  const recipients = await taskRecipients(prisma, payload.taskId, task.document.authorId);
  if (!recipients.includes(payload.userId)) return null;
  const user = await prisma.user.findUnique({ where: { id: payload.userId }, select: { email: true, isActive: true } });
  return user?.isActive ? { email: user.email, number: task.document.number, dueAt: task.dueAt } : null;
}

/** Bez treści odpowiedzi serwera: zwykle cytuje ona adres odbiorcy. */
function smtpFailure(error: unknown) {
  const { responseCode, code } = error as { responseCode?: number; code?: string };
  return { responseCode, label: `SMTP: ${responseCode ?? code ?? "nieznany błąd"}` };
}

/**
 * Obsługa `mail.task.assigned`. Sama ustala ponowienia, więc po błędzie SMTP nie rzuca wyjątku do
 * pętli workera. Stały Message-ID pozwala rozpoznać duplikat, gdy po wysłaniu nie uda się zapisać stanu.
 */
export async function processTaskMail(message: OutboxMessage) {
  // `attempts` w obiekcie pochodzi sprzed przejęcia, które zwiększyło licznik w bazie.
  const attempt = message.attempts + 1;
  if (attempt > TASK_MAIL_MAX_ATTEMPTS) return close(message.id, "Przekroczono limit prób wysyłki");
  const payload = parsePayload(message.payloadJson);
  if (!payload) return close(message.id, "Nieprawidłowa treść komunikatu");
  const delivery = await currentDelivery(payload);
  if (!delivery) return close(message.id, "Przydział nieaktualny: maila nie wysłano");

  const url = documentUrl(payload.documentId);
  return sendOutboxMail(message, {
    to: delivery.email,
    content: taskMailContent({ number: delivery.number, dueAt: delivery.dueAt, url }),
    url,
    label: "mail o zadaniu",
    context: { taskId: payload.taskId }
  });
}

export function documentUrl(documentId: string) {
  return `${env.FRONTEND_URL.replace(/\/$/, "")}/documents/${encodeURIComponent(documentId)}`;
}

/**
 * Wysyłka maila z komunikatu outboxa z ponowieniami: wspólna dla maili o zadaniu i „do wiadomości”.
 * Po błędzie SMTP nie rzuca do pętli workera, tylko sama planuje ponowienie. Stały Message-ID
 * pozwala rozpoznać duplikat, gdy po wysłaniu nie uda się zapisać stanu.
 */
export async function sendOutboxMail(
  message: OutboxMessage,
  input: { to: string; content: { subject: string; text: string }; url: string; label: string; context: Record<string, unknown> }
) {
  const attempt = message.attempts + 1;
  // Błąd odczytu konfiguracji leci do workera, który ponowi komunikat. Nie wolno go zamknąć jako „brak SMTP”.
  const smtp = await getSmtpSettings();
  if (!smtp) {
    if (env.NODE_ENV === "production") logger.error(`Brak SMTP: nie wysłano (${input.label})`, { messageId: message.id, ...input.context });
    else logger.info(`Brak SMTP: link tylko w logu (tryb lokalny, ${input.label})`, { url: input.url });
    return close(message.id, "Brak konfiguracji SMTP");
  }

  try {
    await sendMail(smtp, { to: input.to, messageId: `<outbox-${message.id}@aprobis.local>`, ...input.content });
  } catch (error) {
    const failure = smtpFailure(error);
    // 5xx to trwałe odrzucenie, np. nieistniejący adres. Ponawianie niczego nie zmieni.
    const permanent = failure.responseCode !== undefined && failure.responseCode >= 500;
    if (permanent || attempt >= TASK_MAIL_MAX_ATTEMPTS) {
      logger.error(`Nie wysłano (${input.label})`, { messageId: message.id, ...input.context, attempt, failure: failure.label });
      return close(message.id, failure.label);
    }
    logger.warn("Serwer poczty chwilowo niedostępny, mail zostanie ponowiony", { messageId: message.id, attempt, failure: failure.label });
    return prisma.outboxMessage.update({
      where: { id: message.id },
      data: {
        lockedAt: null,
        lockedBy: null,
        lastError: failure.label,
        availableAt: new Date(Date.now() + Math.min(60, attempt * 5) * 60 * 1000)
      }
    });
  }
  return close(message.id);
}
