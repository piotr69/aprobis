import type { OutboxMessage } from "@prisma/client";
import { StageRecipientStatus } from "../../shared/domain.js";
import { prisma } from "../../shared/prisma.js";
import { close, documentUrl, sendOutboxMail, TASK_MAIL_MAX_ATTEMPTS } from "./task-mail.js";

/**
 * Mail wychodzi poza program, więc jak mail o zadaniu nie zawiera tytułu ani pól dokumentu.
 * Nie ma w nim terminu ani prośby o decyzję: dokument jest tylko do wiadomości.
 */
export function stageInfoMailContent(input: { number: string; url: string }) {
  return {
    subject: `Aprobis: dokument do wiadomości (${input.number})`,
    text: `Dzień dobry,\n\nw programie Aprobis przekazano Ci do wiadomości dokument ${input.number}.\nNie musisz podejmować decyzji.\n\nOtwórz dokument:\n${input.url}\n\nWiadomość wysłano automatycznie. Prosimy na nią nie odpowiadać.`
  };
}

function parseRecipientId(json: string) {
  try {
    const value = JSON.parse(json) as { recipientId?: unknown };
    return typeof value.recipientId === "string" ? value.recipientId : null;
  } catch {
    return null;
  }
}

/**
 * Obsługa `mail.stage.info`. Działa także po zatwierdzeniu dokumentu (końcowy etap „do wiadomości”).
 * Nie wysyła, gdy wgląd cofnięto (zwrot do poprawy, anulowanie) albo konto jest nieaktywne.
 */
export async function processStageInfoMail(message: OutboxMessage) {
  const attempt = message.attempts + 1;
  if (attempt > TASK_MAIL_MAX_ATTEMPTS) return close(message.id, "Przekroczono limit prób wysyłki");
  const recipientId = parseRecipientId(message.payloadJson);
  if (!recipientId) return close(message.id, "Nieprawidłowa treść komunikatu");
  const recipient = await prisma.workflowStageRecipient.findUnique({
    where: { id: recipientId },
    select: { status: true, documentId: true, user: { select: { email: true, isActive: true } }, document: { select: { number: true } } }
  });
  if (!recipient || recipient.status !== StageRecipientStatus.GRANTED) return close(message.id, "Wgląd cofnięty: maila nie wysłano");
  if (!recipient.user.isActive) return close(message.id, "Konto nieaktywne: maila nie wysłano");

  const url = documentUrl(recipient.documentId);
  return sendOutboxMail(message, {
    to: recipient.user.email,
    content: stageInfoMailContent({ number: recipient.document.number, url }),
    url,
    label: "mail do wiadomości",
    context: { recipientId }
  });
}
