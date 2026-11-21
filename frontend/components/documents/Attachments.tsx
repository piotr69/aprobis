"use client";

import { Download, Eye, Paperclip, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge, Card, EmptyState, Modal } from "@/components/ui";
import { useToast } from "@/components/ui/toast";
import { apiRequest, apiRequestRaw, errorText, remove } from "@/lib/api";
import { date, fileSize } from "@/lib/format";
import { useInvalidateWork } from "@/lib/queries";
import type { DocumentDetail, DocumentFile } from "@/lib/types";

const scanLabels: Record<DocumentFile["scanStatus"], { tone: string; text: string }> = {
  PENDING: { tone: "info", text: "Skanowanie…" },
  CLEAN: { tone: "success", text: "Bezpieczny" },
  REJECTED: { tone: "danger", text: "Zablokowany przez antywirus" },
  NOT_SCANNED: { tone: "warning", text: "Nie skanowano — antywirus wyłączony" }
};

/** NOT_SCANNED pojawia się tylko przy wyłączonym skanowaniu; serwer i tak sprawdza, czy plik wolno wydać. */
function canDownload(file: DocumentFile) {
  return file.scanStatus === "CLEAN" || file.scanStatus === "NOT_SCANNED";
}

function canPreview(file: DocumentFile) {
  return canDownload(file) && (file.mimeType === "application/pdf" || file.mimeType.startsWith("image/"));
}

function PreviewModal({ documentId, file, onClose }: { documentId: string; file: DocumentFile; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let created: string | null = null;
    apiRequestRaw(`/documents/${documentId}/files/${file.id}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Nie udało się wczytać pliku");
        created = URL.createObjectURL(await response.blob());
        setUrl(created);
      })
      .catch((previewError: unknown) => setError(errorText(previewError)));
    return () => { if (created) URL.revokeObjectURL(created); };
  }, [documentId, file.id]);

  return (
    <Modal title={file.originalName} onClose={onClose} size="lg">
      {error && <p className="text-danger">{error}</p>}
      {!url && !error && <p className="loading">Wczytywanie podglądu…</p>}
      {url && (file.mimeType === "application/pdf"
        ? <iframe src={url} className="file-frame" title={file.originalName} />
        // eslint-disable-next-line @next/next/no-img-element
        : <img src={url} alt={file.originalName} className="file-image" />)}
    </Modal>
  );
}

export function Attachments({ document }: { document: DocumentDetail }) {
  const toast = useToast();
  const invalidate = useInvalidateWork();
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<DocumentFile | null>(null);
  const [uploading, setUploading] = useState(false);
  const canUpload = document.actionsAllowed.canUpload;

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        await apiRequest(`/documents/${document.id}/files`, { method: "POST", body: form });
      }
      await invalidate();
    } catch (uploadError) {
      toast.error(errorText(uploadError));
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  }

  async function download(file: DocumentFile) {
    const response = await apiRequestRaw(`/documents/${document.id}/files/${file.id}/download`);
    if (!response.ok) {
      toast.error("Nie udało się pobrać pliku");
      return;
    }
    const url = URL.createObjectURL(await response.blob());
    const anchor = Object.assign(window.document.createElement("a"), { href: url, download: file.originalName });
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function deleteFile(file: DocumentFile) {
    try {
      await remove(`/documents/${document.id}/files/${file.id}`);
      await invalidate();
      toast.success("Usunięto załącznik");
    } catch (deleteError) {
      toast.error(errorText(deleteError));
    }
  }

  return (
    <Card
      title="Załączniki"
      aside={canUpload && (
        <>
          <button type="button" className="btn btn-sm" disabled={uploading} onClick={() => input.current?.click()}>
            <Upload size={14} />{uploading ? "Wysyłanie…" : "Dodaj plik"}
          </button>
          <input ref={input} type="file" hidden multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.gif,.txt,.csv" onChange={(event) => upload(event.target.files)} />
        </>
      )}
    >
      {!document.files.length && <EmptyState title="Brak załączników" />}
      <ul className="file-list">
        {document.files.map((file) => (
          <li key={file.id}>
            <Paperclip size={16} aria-hidden="true" className="muted" />
            <div className="file-info">
              <strong>{file.originalName}</strong>
              <small className="muted">{fileSize(file.size)} · {date(file.createdAt)}</small>
            </div>
            <Badge tone={scanLabels[file.scanStatus].tone}>{scanLabels[file.scanStatus].text}</Badge>
            <div className="file-actions">
              {canPreview(file) && <button type="button" className="icon-btn" aria-label={`Podgląd: ${file.originalName}`} onClick={() => setPreview(file)}><Eye size={16} /></button>}
              {canDownload(file) && <button type="button" className="icon-btn" aria-label={`Pobierz: ${file.originalName}`} onClick={() => download(file)}><Download size={16} /></button>}
              {canUpload && <button type="button" className="icon-btn" aria-label={`Usuń: ${file.originalName}`} onClick={() => deleteFile(file)}><Trash2 size={16} /></button>}
            </div>
          </li>
        ))}
      </ul>
      {preview && <PreviewModal documentId={document.id} file={preview} onClose={() => setPreview(null)} />}
    </Card>
  );
}
