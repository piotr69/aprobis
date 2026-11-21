"use client";

import Link from "next/link";
import { Banner, Card, EmptyState, Loading, PageHeader, StatusBadge } from "@/components/ui";
import { errorText } from "@/lib/api";
import { actionLabels, dateTime, fullName } from "@/lib/format";
import { useMyActions, useRoles } from "@/lib/queries";
import type { MyAction } from "@/lib/types";

const STILL_RUNNING = ["IN_APPROVAL", "NEEDS_CORRECTION", "DRAFT", "REGISTERED"];

function documentState(action: MyAction, roleLabel: (role?: string | null) => string | undefined) {
  const { document } = action;
  if (document.status === "NEEDS_CORRECTION") return "Czeka na poprawki autora";
  if (document.status === "DRAFT") return "Szkic";
  if (STILL_RUNNING.includes(document.status)) {
    const people = document.tasks.map((task) => (task.assignedTo ? fullName(task.assignedTo) : roleLabel(task.assignedRole))).filter(Boolean);
    return people.length ? `Obieg trwa, teraz u: ${[...new Set(people)].join(", ")}` : "Obieg trwa, u kolejnych osób";
  }
  return "Obieg zakończony";
}

export default function DonePage() {
  const actions = useMyActions();
  const roles = useRoles();
  const roleLabel = (role?: string | null) => roles.data?.find((item) => item.role === role)?.label;
  return (
    <>
      <PageHeader
        title="Wykonane przeze mnie"
        description="Twoje decyzje i czynności. Zrobione przez Ciebie nie znaczy zakończone: po Twojej decyzji dokument może iść dalej, a stan obiegu widać przy każdym wpisie."
      />
      <Card>
        {actions.isPending && <Loading />}
        {actions.error && <Banner tone="danger" title="Nie udało się wczytać historii">{errorText(actions.error)}</Banner>}
        {!actions.isPending && !actions.error && !actions.items.length && (
          <EmptyState title="Nic jeszcze nie wykonano">Gdy podejmiesz decyzję albo złożysz dokument, zobaczysz to tutaj.</EmptyState>
        )}
        {actions.items.length > 0 && (
          <div className="work-section">
            {actions.items.map((action) => (
              <div key={action.id} className="work-row">
                <div className="work-main">
                  <span className="work-action work-action-neutral">
                    {actionLabels[action.actionType] ?? action.actionType}{action.task ? `: ${action.task.name}` : ""}
                  </span>
                  <Link href={`/documents/${action.document.id}`} className="row-title">{action.document.title}</Link>
                  <small className="muted">{action.document.number} · {action.document.type.name} · {dateTime(action.createdAt)}</small>
                  {action.comment && <p className="small">{action.comment}</p>}
                </div>
                <div className="done-state">
                  <StatusBadge status={action.document.status} />
                  <small className="muted">{documentState(action, roleLabel)}</small>
                </div>
              </div>
            ))}
          </div>
        )}
        {actions.hasNextPage && (
          <div className="load-more">
            <button type="button" className="btn" disabled={actions.isFetchingNextPage} onClick={() => actions.fetchNextPage()}>
              {actions.isFetchingNextPage ? "Wczytywanie…" : "Pokaż więcej"}
            </button>
          </div>
        )}
      </Card>
    </>
  );
}
