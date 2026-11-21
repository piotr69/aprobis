import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { fileTypeFromFile } from "file-type";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { fileStorageRoot } from "../../config/env.js";
import { authenticate, requireCapability } from "../../middleware/auth.js";
import { asyncHandler, AppError, requireParam } from "../../shared/http.js";
import { prisma } from "../../shared/prisma.js";
import { requestAuditContext, writeAuditInTransaction } from "../../shared/audit.js";
import { serializableTransaction } from "../../shared/transactions.js";
import {
  assertDocumentAccess,
  assertDocumentPermission,
  commentVisibilityWhere,
  CommentVisibility,
  documentActionsFor,
  documentVisibilityWhere,
  DocumentPermission,
  taskAssignedToUserWhere,
  workflowActionVisibilityWhere
} from "../../shared/access.js";
import { publicUserSelect } from "../../shared/userSelect.js";
import { isFileUsable } from "../files/fileAvailability.js";
import { canArchiveCategory } from "../../shared/roles.js";
import { approvalLimitFlags } from "../workflow/approvalLimitFlags.js";
import { previewWorkflow, startWorkflow } from "../workflow/workflow.engine.js";
import { DocumentStatus, EDITABLE_DOCUMENT_STATUSES, WorkflowTaskStatus } from "../../shared/domain.js";
import { loadDocumentTypeConfiguration, serializeFields } from "../document-types/document-config.service.js";
import { archiveDocument, cancelDocument, createDraft, deleteDraft, updateDraft } from "./document.service.js";

export const documentRouter = Router();

fs.mkdirSync(fileStorageRoot, { recursive: true });

const acceptedDetectedMimeTypes = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
]);
const textExtensions = new Set([".txt", ".csv"]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, fileStorageRoot),
    filename: (_req, _file, callback) => callback(null, randomUUID())
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  // Domyślne latin1 psuje polskie znaki w nazwach plików.
  defParamCharset: "utf8"
} as multer.Options);

const fileSelect = {
  id: true,
  documentId: true,
  version: true,
  originalName: true,
  mimeType: true,
  detectedMimeType: true,
  sha256: true,
  scanStatus: true,
  scanMessage: true,
  scannedAt: true,
  size: true,
  uploadedById: true,
  createdAt: true
} as const;

const amountSchema = z.string().trim().regex(/^\d{1,16}(\.\d{1,2})?$/, "Wpisz kwotę, np. 1250.50");

/** Progi kwotowe i reguły znają te waluty. Inna waluta ominęłaby pełną ścieżkę akceptacji. */
const currencySchema = z.string().trim().toUpperCase().pipe(z.enum(["PLN", "EUR", "USD"], { message: "Obsługiwane waluty to PLN, EUR i USD" }));

const documentInputSchema = z.object({
  title: z.string().trim().min(3).max(240),
  typeId: z.string().min(1),
  amount: amountSchema.optional().nullable(),
  currency: currencySchema.default("PLN"),
  contractorName: z.string().trim().max(240).optional().nullable(),
  costCenterId: z.string().optional().nullable(),
  projectId: z.string().optional().nullable(),
  location: z.string().trim().max(120).optional().nullable(),
  data: z.record(z.unknown()).optional()
});

const documentPatchSchema = documentInputSchema.partial().extend({
  expectedVersion: z.number().int().positive()
});

const SORTABLE_LIMIT = { min: 1, max: 100, default: 50 };

documentRouter.use(authenticate);

documentRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const limit = z.coerce.number().int().min(SORTABLE_LIMIT.min).max(SORTABLE_LIMIT.max).default(SORTABLE_LIMIT.default).parse(req.query.limit);
    const cursor = typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : undefined;
    const filters: Prisma.DocumentWhereInput[] = [documentVisibilityWhere(req.user!)];
    if (typeof req.query.status === "string" && req.query.status) {
      const statuses = req.query.status.split(",").filter((status) => Object.values(DocumentStatus).includes(status as never));
      if (statuses.length) filters.push({ status: { in: statuses } });
    }
    if (typeof req.query.typeId === "string" && req.query.typeId) filters.push({ typeId: req.query.typeId });
    if (typeof req.query.search === "string" && req.query.search.trim()) {
      const search = req.query.search.trim();
      filters.push({ OR: [{ title: { contains: search } }, { number: { contains: search } }, { contractorName: { contains: search } }] });
    }
    if (req.query.scope === "created-by-me") filters.push({ authorId: req.user!.id });
    // Dokumenty, w których brałem udział: szeroki wgląd z roli nie czyni ich „moimi”.
    if (req.query.scope === "involved") {
      filters.push({ OR: [{ authorId: req.user!.id }, { actions: { some: { userId: req.user!.id } } }] });
    }
    if (req.query.scope === "assigned-to-me") {
      filters.push({
        tasks: { some: {
          status: { in: [WorkflowTaskStatus.OPEN, WorkflowTaskStatus.OVERDUE] },
          ...taskAssignedToUserWhere(req.user!)
        } }
      });
    }

    const documents = await prisma.document.findMany({
      where: { AND: filters },
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        currentStepName: true,
        amount: true,
        currency: true,
        contractorName: true,
        version: true,
        createdAt: true,
        updatedAt: true,
        submittedAt: true,
        type: { select: { id: true, code: true, name: true, category: true } },
        author: { select: { id: true, firstName: true, lastName: true } },
        department: { select: { id: true, code: true, name: true } },
        _count: { select: { files: true } },
        tasks: {
          where: { status: { in: [WorkflowTaskStatus.OPEN, WorkflowTaskStatus.OVERDUE] } },
          select: {
            id: true, name: true, status: true, dueAt: true, assignedRole: true,
            assignedTo: { select: { id: true, firstName: true, lastName: true } }
          },
          orderBy: { order: "asc" }
        }
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });
    const hasNextPage = documents.length > limit;
    const items = hasNextPage ? documents.slice(0, limit) : documents;
    const total = await prisma.document.count({ where: { AND: filters } });
    res.json({ items, pageInfo: { hasNextPage, nextCursor: hasNextPage ? items.at(-1)?.id ?? null : null, total } });
  })
);

documentRouter.post(
  "/",
  requireCapability("createDocuments"),
  asyncHandler(async (req, res) => {
    const input = documentInputSchema.parse(req.body);
    const document = await createDraft({ ...input, data: input.data ?? {} }, { userId: req.user!.id, ...requestAuditContext(req) });
    res.status(201).json(document);
  })
);

documentRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    // Kontrola dostępu, ustalenie „tylko do wiadomości” (filtr notatek) i odczyt treści w jednej transakcji
    // Serializable: zwrot do poprawy czy przepisanie zadania w tym czasie nie ujawni nowej treści ani notatek.
    const { authorized, document } = await serializableTransaction(async (tx) => {
      const authorized = await assertDocumentAccess(id, req.user, tx);
      const document = await tx.document.findFirst({
      where: { AND: [{ id }, documentVisibilityWhere(req.user!)] },
      include: {
        type: { select: { id: true, code: true, name: true, category: true, requiresAmount: true, requiresContractor: true, titleTemplate: true } },
        author: { select: publicUserSelect },
        department: { select: { id: true, code: true, name: true } },
        costCenter: { select: { id: true, code: true, name: true } },
        project: { select: { id: true, code: true, name: true } },
        files: { select: fileSelect, orderBy: { version: "desc" } },
        comments: {
          where: commentVisibilityWhere(req.user!, authorized),
          include: { user: { select: publicUserSelect } },
          orderBy: { createdAt: "asc" }
        },
        workflowInstances: {
          include: {
            stages: {
              include: {
                tasks: {
                  select: {
                    id: true, name: true, status: true, version: true, dueAt: true, completedAt: true, assignedRole: true,
                    assignedTo: { select: publicUserSelect },
                    candidates: { select: { user: { select: publicUserSelect } } }
                  }
                },
                // Odbiorcy etapu „do wiadomości” (także cofnięci: historia pokazuje, komu przekazano).
                recipients: { select: { status: true, user: { select: publicUserSelect } } }
              },
              orderBy: [{ stageNo: "asc" }, { parallelGroup: "asc" }]
            }
          },
          orderBy: { startedAt: "desc" }
        },
        actions: {
          // Wpisy COMMENT powielają treść komentarza, w tym notatek wewnętrznych.
          where: workflowActionVisibilityWhere(req.user!, authorized),
          include: { user: { select: publicUserSelect } },
          orderBy: { createdAt: "asc" }
        }
      }
      });
      if (!document) throw new AppError(403, "Nie masz dostępu do tego dokumentu");
      return { authorized, document };
    });
    // Pola formularza według wersji przypiętej do dokumentu. Formularz z aktualnej wersji
    // typu gubił dane i blokował ponowne złożenie, gdy definicja zmieniła się po utworzeniu.
    const configuration = await loadDocumentTypeConfiguration(document.typeId, document.typeVersionId, { allowInactive: true });
    const myTask = await prisma.workflowTask.findFirst({
      where: { documentId: id, status: WorkflowTaskStatus.OPEN, document: { authorId: { not: req.user!.id } }, ...taskAssignedToUserWhere(req.user!) },
      select: {
        id: true, name: true, version: true, dueAt: true, assignedToId: true,
        instanceStage: { select: { requiresComment: true, requiresAttachment: true, canDelegate: true, canReturn: true } }
      },
      orderBy: { order: "asc" }
    });
    // Limit liczony jak przy decyzji: w zastępstwie także limit zastępowanego.
    const limitExceeded = myTask
      ? (await approvalLimitFlags(req.user!, [{ id: myTask.id, document }])).get(myTask.id) ?? false
      : false;
    res.json({
      ...document,
      formFields: serializeFields(configuration.fields),
      // Szablon tytułu należy do wersji formularza tak samo jak pola.
      formTitleTemplate: configuration.version ? configuration.version.titleTemplate : document.type.titleTemplate,
      actionsAllowed: await documentActionsFor(authorized, req.user!),
      // Zadanie z roli ponad limit należy do kogoś innego; przypisane można przekazać lub zwrócić.
      myTask: myTask && (myTask.assignedToId || !limitExceeded) ? { ...myTask, approvalLimitExceeded: limitExceeded } : null
    });
  })
);

documentRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    await assertDocumentPermission(id, req.user, DocumentPermission.EDIT);
    const { expectedVersion, data, ...input } = documentPatchSchema.parse(req.body);
    const document = await updateDraft(id, expectedVersion, { ...input, ...(data ? { data } : {}) }, { userId: req.user!.id, ...requestAuditContext(req) });
    res.json(document);
  })
);

function permissionGuard(permission: DocumentPermission) {
  return asyncHandler(async (req, _res, next) => {
    await assertDocumentPermission(requireParam(req.params.id, "id"), req.user, permission);
    next();
  });
}

/**
 * Każda zmiana załączników podnosi wersję dokumentu w warunku na status. Składanie porównuje
 * wersję z odczytem użytym do walidacji, więc plik nie zniknie ani nie dojdzie w połowie
 * składania, a dokument już złożony odrzuci spóźnioną operację.
 */
async function touchEditableDocument(tx: Prisma.TransactionClient, id: string) {
  const changed = await tx.document.updateMany({
    where: { id, status: { in: [...EDITABLE_DOCUMENT_STATUSES] } },
    data: { version: { increment: 1 } }
  });
  if (changed.count !== 1) throw new AppError(409, "Dokumentu nie można już zmieniać, bo został złożony");
}

async function inspectUploadedFile(filePath: string, originalName: string) {
  const detected = await fileTypeFromFile(filePath);
  const extension = path.extname(originalName).toLowerCase();
  let detectedMimeType = detected?.mime as string | undefined;
  if (!detected && textExtensions.has(extension)) {
    const handle = await fs.promises.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(8192);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (buffer.subarray(0, bytesRead).includes(0)) throw new AppError(415, "Zawartość pliku nie jest zwykłym tekstem");
      detectedMimeType = extension === ".csv" ? "text/csv" : "text/plain";
    } finally {
      await handle.close();
    }
  }
  if (!detectedMimeType || (!acceptedDetectedMimeTypes.has(detectedMimeType) && !["text/plain", "text/csv"].includes(detectedMimeType))) {
    throw new AppError(415, "Nieobsługiwany format pliku. Dozwolone: PDF, Word, Excel, obrazy, TXT i CSV");
  }
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(filePath).on("data", (chunk) => hash.update(chunk)).on("end", resolve).on("error", reject);
  });
  return { detectedMimeType, sha256: hash.digest("hex") };
}

documentRouter.post(
  "/:id/files",
  permissionGuard(DocumentPermission.UPLOAD),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    if (!req.file) throw new AppError(400, "Wybierz plik");
    const uploaded = req.file;
    try {
      const inspection = await inspectUploadedFile(uploaded.path, uploaded.originalname);
      const file = await serializableTransaction(async (tx) => {
        // Przesyłanie trwa: dokument mógł w tym czasie zostać złożony.
        await touchEditableDocument(tx, id);
        const latest = await tx.documentFile.aggregate({ where: { documentId: id }, _max: { version: true } });
        const created = await tx.documentFile.create({
          data: {
            documentId: id,
            version: (latest._max.version ?? 0) + 1,
            originalName: path.basename(uploaded.originalname),
            storagePath: uploaded.path,
            mimeType: inspection.detectedMimeType,
            detectedMimeType: inspection.detectedMimeType,
            sha256: inspection.sha256,
            scanStatus: "PENDING",
            size: uploaded.size,
            uploadedById: req.user!.id
          },
          select: fileSelect
        });
        await tx.outboxMessage.create({
          data: {
            topic: "file.scan.requested",
            aggregateType: "DOCUMENT_FILE",
            aggregateId: created.id,
            payloadJson: JSON.stringify({ fileId: created.id, storagePath: uploaded.path, sha256: inspection.sha256 })
          }
        });
        await writeAuditInTransaction(tx, {
          userId: req.user!.id,
          entityType: "DOCUMENT_FILE",
          entityId: created.id,
          action: "UPLOAD_PENDING_SCAN",
          after: { documentId: id, originalName: created.originalName, size: created.size, sha256: created.sha256 },
          ...requestAuditContext(req)
        });
        return created;
      });
      res.status(202).json(file);
    } catch (error) {
      // Plik bez rekordu w bazie nigdy nie zostałby zeskanowany ani usunięty.
      await fs.promises.unlink(uploaded.path).catch(() => undefined);
      throw error;
    }
  })
);

documentRouter.get(
  "/:id/files",
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    await assertDocumentAccess(id, req.user);
    // Warunek wglądu w tym samym zapytaniu: cofnięty w międzyczasie wgląd nie pokaże plików dodanych w korekcie.
    res.json(await prisma.documentFile.findMany({ where: { documentId: id, document: documentVisibilityWhere(req.user!) }, orderBy: { version: "desc" }, select: fileSelect }));
  })
);

documentRouter.delete(
  "/:id/files/:fileId",
  permissionGuard(DocumentPermission.UPLOAD),
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    const fileId = requireParam(req.params.fileId, "fileId");
    const file = await prisma.documentFile.findFirst({ where: { id: fileId, documentId: id } });
    if (!file) throw new AppError(404, "Nie znaleziono pliku");
    await serializableTransaction(async (tx) => {
      await touchEditableDocument(tx, id);
      await tx.documentFile.delete({ where: { id: fileId } });
      await writeAuditInTransaction(tx, {
        userId: req.user!.id,
        entityType: "DOCUMENT_FILE",
        entityId: fileId,
        action: "FILE_DELETED",
        before: { documentId: id, originalName: file.originalName, sha256: file.sha256 },
        ...requestAuditContext(req)
      });
    });
    await fs.promises.unlink(file.storagePath).catch(() => undefined);
    res.status(204).end();
  })
);

async function serveFile(req: Request, res: Response, download: boolean) {
  const id = requireParam(req.params.id, "id");
  const fileId = requireParam(req.params.fileId, "fileId");
  await assertDocumentAccess(id, req.user);
  const file = await prisma.documentFile.findFirst({ where: { id: fileId, documentId: id, document: documentVisibilityWhere(req.user!) } });
  if (!file) throw new AppError(404, "Nie znaleziono pliku");
  if (!isFileUsable(file.scanStatus)) throw new AppError(423, "Plik będzie dostępny po zakończeniu skanowania antywirusowego");
  const resolvedPath = path.resolve(file.storagePath);
  if (resolvedPath !== fileStorageRoot && !resolvedPath.startsWith(fileStorageRoot + path.sep)) throw new AppError(400, "Nieprawidłowa ścieżka pliku");
  if (!fs.existsSync(resolvedPath)) throw new AppError(404, "Zawartość pliku nie jest już dostępna");
  res.setHeader("Content-Type", file.detectedMimeType ?? "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (download) return res.download(resolvedPath, file.originalName);
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.originalName)}`);
  return res.sendFile(resolvedPath);
}

documentRouter.get("/:id/files/:fileId", asyncHandler((req, res) => serveFile(req, res, false)));
documentRouter.get("/:id/files/:fileId/download", asyncHandler((req, res) => serveFile(req, res, true)));

documentRouter.get(
  "/:id/workflow-preview",
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    await assertDocumentAccess(id, req.user);
    res.json({ stages: await previewWorkflow(id) });
  })
);

documentRouter.post(
  "/:id/submit",
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    await assertDocumentPermission(id, req.user, DocumentPermission.SUBMIT);
    const result = await startWorkflow(id, { userId: req.user!.id, role: req.user!.role, ...requestAuditContext(req) });
    res.status(201).json(result);
  })
);

documentRouter.post(
  "/:id/cancel",
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    await assertDocumentPermission(id, req.user, DocumentPermission.CANCEL);
    const { expectedVersion, reason } = z.object({
      expectedVersion: z.number().int().positive(),
      reason: z.string().trim().max(1000).optional()
    }).parse(req.body);
    res.json(await cancelDocument(id, expectedVersion, reason, { userId: req.user!.id, ...requestAuditContext(req) }));
  })
);

documentRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    await assertDocumentPermission(id, req.user, DocumentPermission.DELETE);
    // Wersja w adresie, bo nie każdy pośrednik przenosi treść żądania DELETE.
    const { expectedVersion } = z.object({ expectedVersion: z.coerce.number().int().positive() }).parse(req.query);
    await deleteDraft(id, expectedVersion, { userId: req.user!.id, ...requestAuditContext(req) });
    res.status(204).end();
  })
);

documentRouter.post(
  "/:id/archive",
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    const document = await assertDocumentAccess(id, req.user);
    if (!canArchiveCategory(req.user!.role, document.type.category)) throw new AppError(403, "Nie możesz archiwizować tego dokumentu");
    const { expectedVersion } = z.object({ expectedVersion: z.number().int().positive() }).parse(req.body);
    res.json(await archiveDocument(id, expectedVersion, { userId: req.user!.id, ...requestAuditContext(req) }));
  })
);

const commentSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  visibility: z.nativeEnum(CommentVisibility).default(CommentVisibility.AUTHOR),
  taskId: z.string().optional().nullable()
});

documentRouter.post(
  "/:id/comments",
  asyncHandler(async (req, res) => {
    const id = requireParam(req.params.id, "id");
    await assertDocumentPermission(id, req.user, DocumentPermission.COMMENT);
    const input = commentSchema.parse(req.body);
    if (input.taskId) {
      const belongs = await prisma.workflowTask.count({ where: { id: input.taskId, documentId: id } });
      if (!belongs) throw new AppError(400, "To zadanie nie dotyczy tego dokumentu");
    }
    const comment = await prisma.$transaction(async (tx) => {
      const created = await tx.comment.create({ data: { documentId: id, userId: req.user!.id, taskId: input.taskId, body: input.body, visibility: input.visibility } });
      await writeAuditInTransaction(tx, {
        userId: req.user!.id,
        entityType: "DOCUMENT",
        entityId: id,
        action: "COMMENT_ADDED",
        after: { commentId: created.id, taskId: input.taskId, visibility: input.visibility },
        ...requestAuditContext(req)
      });
      return created;
    });
    res.status(201).json(comment);
  })
);
