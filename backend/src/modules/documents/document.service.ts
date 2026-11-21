import type { Prisma } from "@prisma/client";
import { CANCELLABLE_DOCUMENT_STATUSES, DocumentStatus, EDITABLE_DOCUMENT_STATUSES, WorkflowActionType } from "../../shared/domain.js";
import { AppError } from "../../shared/http.js";
import { prisma } from "../../shared/prisma.js";
import { writeAuditInTransaction } from "../../shared/audit.js";
import { serializableTransaction } from "../../shared/transactions.js";
import {
  replaceFieldProjections,
  validateDocumentForPhase
} from "../document-types/document-config.service.js";
import { cancelWorkflowOfDocument } from "../workflow/workflow.engine.js";
import { OutboxTopic } from "../files/outbox.processor.js";

export type DocumentInput = {
  title: string;
  typeId: string;
  amount?: string | null;
  currency: string;
  contractorName?: string | null;
  costCenterId?: string | null;
  projectId?: string | null;
  location?: string | null;
  data: Record<string, unknown>;
};

type RequestContext = {
  userId: string;
  correlationId: string;
  ipAddress?: string;
  userAgent?: string;
};

/**
 * Jaką wartość `typeVersionId` zapisać przy edycji szkicu.
 *
 * Prisma traktuje `undefined` jako „nie zmieniaj tej kolumny", więc przy zmianie typu
 * dokumentu trzeba jawnie podać `null`, jeśli nowy typ nie ma opublikowanej wersji —
 * inaczej dokument zostaje z wersją poprzedniego typu i renderuje cudze pola.
 */
export function resolveTypeVersionUpdate(typeChanged: boolean, versionId: string | undefined) {
  if (!typeChanged) return undefined;
  return versionId ?? null;
}

async function nextDocumentNumber(tx: Prisma.TransactionClient) {
  const year = new Date().getFullYear();
  const sequence = await tx.documentNumberSequence.upsert({
    where: { scope_year: { scope: "DMS", year } },
    create: { scope: "DMS", year, nextValue: 2 },
    update: { nextValue: { increment: 1 } }
  });
  return `DMS/${year}/${String(sequence.nextValue - 1).padStart(6, "0")}`;
}

export async function createDraft(input: DocumentInput, context: RequestContext) {
  const config = await validateDocumentForPhase({
    typeId: input.typeId,
    data: input.data,
    amount: input.amount,
    contractorName: input.contractorName
  }, "DRAFT");
  // Dział wyznacza akceptujących, więc ustala go serwer z profilu autora.
  // Wybór w formularzu pozwalał skierować dokument do łagodniejszego kierownika.
  const author = await prisma.user.findUniqueOrThrow({ where: { id: context.userId }, select: { departmentId: true } });

  return serializableTransaction(async (tx) => {
    const document = await tx.document.create({
      data: {
        number: await nextDocumentNumber(tx),
        title: input.title,
        typeId: input.typeId,
        typeVersionId: config.version?.id,
        authorId: context.userId,
        departmentId: author.departmentId ?? undefined,
        amount: input.amount ?? undefined,
        currency: input.currency,
        contractorName: input.contractorName ?? undefined,
        costCenterId: input.costCenterId ?? undefined,
        projectId: input.projectId ?? undefined,
        location: input.location ?? undefined,
        dataJson: JSON.stringify(config.data),
        metadataJson: JSON.stringify(config.data),
        status: DocumentStatus.DRAFT
      }
    });
    await replaceFieldProjections(tx, document.id, config.fields, config.data);
    await writeAuditInTransaction(tx, {
      userId: context.userId,
      entityType: "DOCUMENT",
      entityId: document.id,
      action: "DRAFT_CREATED",
      after: { number: document.number, typeId: document.typeId },
      correlationId: context.correlationId,
      recordVersion: document.version,
      statusAfter: document.status,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent
    });
    return document;
  });
}

export async function updateDraft(
  documentId: string,
  expectedVersion: number,
  input: Partial<DocumentInput>,
  context: RequestContext
) {
  const before = await prisma.document.findUnique({ where: { id: documentId } });
  if (!before) throw new AppError(404, "Nie znaleziono dokumentu");
  if (!EDITABLE_DOCUMENT_STATUSES.includes(before.status)) {
    throw new AppError(409, "Edytować można tylko szkic lub dokument zwrócony do poprawy");
  }
  // Zmiana typu w korekcie mogłaby przenieść dokument na łagodniejszą ścieżkę akceptacji.
  const typeChanged = Boolean(input.typeId) && input.typeId !== before.typeId;
  if (typeChanged && before.status !== DocumentStatus.DRAFT) {
    throw new AppError(409, "Typ można zmienić tylko w szkicu");
  }

  const existingData = JSON.parse(before.dataJson || before.metadataJson || "{}") as Record<string, unknown>;
  const typeId = input.typeId ?? before.typeId;
  const data = input.data ?? existingData;
  const config = await validateDocumentForPhase({
    typeId,
    typeVersionId: typeChanged ? undefined : before.typeVersionId,
    data,
    amount: input.amount ?? before.amount?.toString(),
    contractorName: input.contractorName ?? before.contractorName
  }, "DRAFT");

  return prisma.$transaction(async (tx) => {
    const result = await tx.document.updateMany({
      where: { id: documentId, version: expectedVersion, status: { in: [...EDITABLE_DOCUMENT_STATUSES] } },
      data: {
        title: input.title,
        typeId: input.typeId,
        typeVersionId: resolveTypeVersionUpdate(typeChanged, config.version?.id),
        amount: input.amount,
        currency: input.currency,
        contractorName: input.contractorName,
        costCenterId: input.costCenterId,
        projectId: input.projectId,
        location: input.location,
        dataJson: input.data ? JSON.stringify(config.data) : undefined,
        metadataJson: input.data ? JSON.stringify(config.data) : undefined,
        version: { increment: 1 }
      }
    });
    if (result.count !== 1) throw new AppError(409, "Ktoś właśnie zmienił ten dokument. Odśwież stronę");
    await replaceFieldProjections(tx, documentId, config.fields, config.data);
    const updated = await tx.document.findUniqueOrThrow({ where: { id: documentId } });
    await writeAuditInTransaction(tx, {
      userId: context.userId,
      entityType: "DOCUMENT",
      entityId: documentId,
      action: "DRAFT_UPDATED",
      before: { version: before.version, status: before.status },
      after: { version: updated.version, status: updated.status },
      correlationId: context.correlationId,
      recordVersion: updated.version,
      statusBefore: before.status,
      statusAfter: updated.status,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent
    });
    return updated;
  });
}

export async function cancelDocument(documentId: string, expectedVersion: number, reason: string | undefined, context: RequestContext) {
  return serializableTransaction(async (tx) => {
    const before = await tx.document.findUnique({ where: { id: documentId } });
    if (!before) throw new AppError(404, "Nie znaleziono dokumentu");
    const result = await tx.document.updateMany({
      where: {
        id: documentId,
        version: expectedVersion,
        status: { in: [...CANCELLABLE_DOCUMENT_STATUSES] }
      },
      data: { status: DocumentStatus.CANCELLED, currentStepName: null, version: { increment: 1 } }
    });
    if (result.count !== 1) throw new AppError(409, "Tego dokumentu nie można teraz wycofać. Odśwież stronę");
    await cancelWorkflowOfDocument(tx, documentId);
    const updated = await tx.document.findUniqueOrThrow({ where: { id: documentId } });
    await tx.workflowAction.create({
      data: { documentId, userId: context.userId, actionType: "CANCEL", comment: reason?.trim() || undefined }
    });
    if (context.userId !== before.authorId) {
      await tx.notification.create({
        data: {
          userId: before.authorId,
          documentId,
          type: "DOCUMENT_CANCELLED",
          title: `Dokument wycofany: ${before.title}`.slice(0, 180),
          body: (reason?.trim() || before.number).slice(0, 500)
        }
      });
    }
    await writeAuditInTransaction(tx, {
      userId: context.userId,
      entityType: "DOCUMENT",
      entityId: documentId,
      action: "DOCUMENT_CANCELLED",
      after: { reason },
      correlationId: context.correlationId,
      recordVersion: updated.version,
      statusBefore: before.status,
      statusAfter: updated.status,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent
    });
    return updated;
  });
}

/**
 * Trwałe usunięcie własnego szkicu, który nigdy nie był wysłany do obiegu.
 *
 * Warunki sprawdza warunkowy update w tej samej transakcji, co kasowanie: równoległe
 * wysłanie, edycja albo upload zmieniają wersję lub status, więc przegrają albo wygrają w całości.
 * Pliki z dysku kasuje worker na podstawie komunikatów zapisanych w tej transakcji — rollback
 * nie zostawi rekordów bez plików, a awaria procesu po commicie nie zostawi plików bez rekordów.
 * Numer szkicu nie wraca do puli; audyt zapisuje, co się z nim stało.
 */
export async function deleteDraft(documentId: string, expectedVersion: number, context: RequestContext) {
  return serializableTransaction(async (tx) => {
    const locked = await tx.document.updateMany({
      where: {
        id: documentId,
        version: expectedVersion,
        authorId: context.userId,
        status: DocumentStatus.DRAFT,
        submittedAt: null,
        workflowInstances: { none: {} },
        tasks: { none: {} },
        actions: { none: {} }
      },
      data: { version: { increment: 1 } }
    });
    if (locked.count !== 1) {
      const exists = await tx.document.count({ where: { id: documentId } });
      if (!exists) throw new AppError(404, "Nie znaleziono dokumentu");
      throw new AppError(409, "Usunąć można tylko szkic, który nie był wysłany do obiegu. Odśwież stronę");
    }

    const document = await tx.document.findUniqueOrThrow({
      where: { id: documentId },
      include: { files: { select: { id: true, storagePath: true, originalName: true } } }
    });
    for (const file of document.files) {
      await tx.outboxMessage.create({
        data: {
          topic: OutboxTopic.FILE_DELETE_REQUESTED,
          aggregateType: "DOCUMENT_FILE",
          aggregateId: file.id,
          payloadJson: JSON.stringify({ storagePath: file.storagePath })
        }
      });
    }
    await tx.comment.deleteMany({ where: { documentId } });
    await tx.notification.deleteMany({ where: { documentId } });
    await tx.documentFieldProjection.deleteMany({ where: { documentId } });
    await tx.documentAccessPolicy.deleteMany({ where: { documentId } });
    await tx.documentFile.deleteMany({ where: { documentId } });
    await tx.document.delete({ where: { id: documentId } });
    await writeAuditInTransaction(tx, {
      userId: context.userId,
      entityType: "DOCUMENT",
      entityId: documentId,
      action: "DRAFT_DELETED",
      before: {
        number: document.number,
        title: document.title,
        authorId: document.authorId,
        typeId: document.typeId,
        version: expectedVersion,
        files: document.files.map((file) => file.originalName)
      },
      correlationId: context.correlationId,
      recordVersion: expectedVersion,
      statusBefore: DocumentStatus.DRAFT,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent
    });
  });
}

export async function archiveDocument(documentId: string, expectedVersion: number, context: RequestContext) {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const result = await tx.document.updateMany({
      where: { id: documentId, version: expectedVersion, status: DocumentStatus.APPROVED },
      data: { status: DocumentStatus.ARCHIVED, archivedAt: now, version: { increment: 1 } }
    });
    if (result.count !== 1) throw new AppError(409, "Zarchiwizować można tylko zatwierdzony dokument. Odśwież stronę");
    const updated = await tx.document.findUniqueOrThrow({ where: { id: documentId } });
    await tx.workflowAction.create({ data: { documentId, userId: context.userId, actionType: WorkflowActionType.ARCHIVE } });
    await writeAuditInTransaction(tx, {
      userId: context.userId,
      entityType: "DOCUMENT",
      entityId: documentId,
      action: "DOCUMENT_ARCHIVED",
      correlationId: context.correlationId,
      recordVersion: updated.version,
      statusBefore: DocumentStatus.APPROVED,
      statusAfter: updated.status,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent
    });
    return updated;
  });
}
