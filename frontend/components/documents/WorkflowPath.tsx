"use client";

import { Check, Clock, CornerUpLeft, Minus, X } from "lucide-react";
import type { ReactNode } from "react";
import { Card, Banner, Loading } from "@/components/ui";
import { dateTime, dueText, fullName, isOverdue } from "@/lib/format";
import { useRoles, useWorkflowPreview } from "@/lib/queries";
import type { DocumentDetail, StageTask, WorkflowStage } from "@/lib/types";
import { errorText } from "@/lib/api";

function stageVisual(status: string): { className: string; icon: ReactNode; label: string } {
  switch (status) {
    case "COMPLETED": return { className: "is-done", icon: <Check size={14} />, label: "Zatwierdzono" };
    case "OPEN": return { className: "is-current", icon: <Clock size={14} />, label: "Teraz" };
    case "REJECTED": return { className: "is-rejected", icon: <X size={14} />, label: "Odrzucono" };
    case "RETURNED": return { className: "is-returned", icon: <CornerUpLeft size={14} />, label: "Zwrócono do poprawy" };
    case "CANCELLED": return { className: "is-skipped", icon: <Minus size={14} />, label: "Anulowano" };
    default: return { className: "is-waiting", icon: null, label: "Później" };
  }
}

function useRoleLabel() {
  const { data } = useRoles();
  return (role?: string | null) => data?.find((item) => item.role === role)?.label ?? role ?? "";
}

function approverText(task: StageTask, roleLabel: (role?: string | null) => string) {
  if (task.assignedTo) return fullName(task.assignedTo);
  if (task.assignedRole) return `Rola: ${roleLabel(task.assignedRole)}`;
  const people = task.candidates.map((candidate) => (candidate.user ? fullName(candidate.user) : null)).filter(Boolean);
  return people.length ? people.join(", ") : "Wyznaczona grupa";
}

/** Kopia konfiguracji etapu z chwili złożenia: tu zapisuje się, że przełożony zastąpił wskazanego autora. */
function authorWasReplaced(stage: WorkflowStage) {
  try {
    return Boolean(stage.configSnapshotJson && (JSON.parse(stage.configSnapshotJson) as { authorReplaced?: unknown }).authorReplaced === true);
  } catch {
    return false;
  }
}

function infoVisual(status: string): { className: string; icon: ReactNode; label: string } {
  if (status === "COMPLETED") return { className: "is-done", icon: <Check size={14} />, label: "Przekazano do wiadomości" };
  if (status === "SKIPPED") return { className: "is-skipped", icon: <Minus size={14} />, label: "Pominięto: brak aktywnego odbiorcy" };
  if (status === "CANCELLED") return { className: "is-skipped", icon: <Minus size={14} />, label: "Anulowano" };
  return { className: "is-waiting", icon: null, label: "Do wiadomości, później" };
}

function StageRow({ stage, index }: { stage: WorkflowStage; index: number }) {
  const roleLabel = useRoleLabel();
  const isInfo = stage.stageKind === "INFO";
  const visual = isInfo ? infoVisual(stage.status) : stageVisual(stage.status);
  const approvers = isInfo
    ? (stage.recipients ?? []).map((recipient) => fullName(recipient.user) + (recipient.status === "REVOKED" ? " (wgląd cofnięty)" : ""))
    : [...new Set(stage.tasks.map((task) => approverText(task, roleLabel)))];
  const due = stage.tasks.find((task) => task.status === "OPEN")?.dueAt;
  const finished = stage.completedAt;
  return (
    <li className={`path-step ${visual.className}`}>
      <span className="path-marker" aria-hidden="true">{visual.icon ?? index + 1}</span>
      <div>
        <strong>{stage.name}</strong>
        <small>{approvers.join(", ")}</small>
        {authorWasReplaced(stage) && <small className="muted">Autor był wskazany w tym etapie, więc decyduje przełożony.</small>}
        <small className={stage.status === "OPEN" && isOverdue(due) ? "text-danger" : "muted"}>
          {visual.label}
          {stage.status === "OPEN" && due ? ` · termin: ${dueText(due)}` : ""}
          {finished && stage.status !== "OPEN" && stage.status !== "CANCELLED" ? ` · ${dateTime(finished)}` : ""}
        </small>
      </div>
    </li>
  );
}

function Preview({ document }: { document: DocumentDetail }) {
  const query = useWorkflowPreview(document.id, true, document.version);
  if (query.isPending) return <Loading label="Ustalanie ścieżki…" />;
  if (query.error) return <Banner tone="danger" title="Nie można ustalić ścieżki">{errorText(query.error)}</Banner>;
  return (
    <>
      <p className="muted small">Po złożeniu dokument przejdzie przez te etapy:</p>
      <ol className="path">
        {query.data?.stages.map((stage, index) => (
          <li key={stage.stageNo} className="path-step is-waiting">
            <span className="path-marker" aria-hidden="true">{index + 1}</span>
            <div>
              <strong>{stage.name}{stage.stageKind === "INFO" ? " (do wiadomości)" : ""}</strong>
              <small>{stage.approvers.join(", ") || (stage.stageKind === "INFO" ? "Brak aktywnego odbiorcy: etap zostanie pominięty" : "")}{stage.approvers.length > 1 && stage.completionMode !== "QUORUM" && stage.stageKind !== "INFO" ? (stage.completionMode === "ANY" ? " · wystarczy jedna decyzja" : " · decydują wszyscy") : ""}</small>
              {stage.authorReplaced && <small className="muted">Jesteś wskazany w tym etapie, więc zamiast Ciebie decyduje przełożony.</small>}
              {stage.stageKind !== "INFO" && <small className="muted">Na decyzję: {stage.dueDays} {stage.dueDays === 1 ? "dzień" : "dni"}</small>}
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

export function WorkflowPath({ document }: { document: DocumentDetail }) {
  const beforeSubmit = document.actionsAllowed.canSubmit;
  const latest = document.workflowInstances[0];
  return (
    <Card title="Ścieżka akceptacji">
      {beforeSubmit && <Preview document={document} />}
      {!beforeSubmit && latest && (
        <ol className="path">
          {latest.stages.map((stage, index) => <StageRow key={stage.id} stage={stage} index={index} />)}
        </ol>
      )}
      {!beforeSubmit && !latest && <p className="muted small">Dokument nie został złożony do akceptacji.</p>}
    </Card>
  );
}
