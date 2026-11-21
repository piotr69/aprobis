"use client";

import { Plus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, Banner, Card, EmptyState, ErrorBanner, Field, Loading, Modal, PageHeader } from "@/components/ui";
import { useToast } from "@/components/ui/toast";
import { errorText, patch, post } from "@/lib/api";
import { fullName } from "@/lib/format";
import { useDepartments, useMe, useUsers } from "@/lib/queries";
import type { Department } from "@/lib/types";

function DepartmentDialog({ department, onClose }: { department?: Department; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const users = useUsers();
  const departments = useDepartments();
  const [name, setName] = useState(department?.name ?? "");
  const [code, setCode] = useState(department?.code ?? "");
  const [managerId, setManagerId] = useState(department?.manager?.id ?? "");
  const [parentId, setParentId] = useState(department?.parent?.id ?? "");
  const [isActive, setIsActive] = useState(department?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save() {
    setBusy(true);
    setError(null);
    const body = { name, code, managerId: managerId || null, parentDepartmentId: parentId || null, isActive };
    try {
      if (department) await patch(`/organization/departments/${department.id}`, body);
      else await post("/organization/departments", body);
      await client.invalidateQueries({ queryKey: ["departments"] });
      toast.success("Zapisano dział");
      onClose();
    } catch (saveError) {
      setError(saveError);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={department ? `Edycja: ${department.name}` : "Nowy dział"}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Anuluj</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>{busy ? "Zapisywanie…" : "Zapisz"}</button>
        </>
      )}
    >
      <div className="stack">
        <ErrorBanner error={error} />
        <Field label="Nazwa" required><input value={name} maxLength={180} onChange={(event) => setName(event.target.value)} /></Field>
        <Field label="Kod" required hint="Krótki skrót, np. FIN."><input value={code} maxLength={40} onChange={(event) => setCode(event.target.value)} /></Field>
        <Field label="Kierownik" hint="Akceptuje etapy „Kierownik działu” i widzi złożone dokumenty działu.">
          <select value={managerId} onChange={(event) => setManagerId(event.target.value)}>
            <option value="">Brak</option>
            {(users.data ?? []).filter((user) => user.isActive).map((user) => <option key={user.id} value={user.id}>{fullName(user)}</option>)}
          </select>
        </Field>
        <Field label="Dział nadrzędny">
          <select value={parentId} onChange={(event) => setParentId(event.target.value)}>
            <option value="">Brak</option>
            {(departments.data ?? []).filter((item) => item.id !== department?.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </Field>
        <label className="check"><input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />Dział aktywny</label>
      </div>
    </Modal>
  );
}

export default function DepartmentsPage() {
  const me = useMe();
  const departments = useDepartments();
  const [editing, setEditing] = useState<Department | "new" | null>(null);

  if (!me.capabilities.manageUsers) return <Banner tone="danger" title="Brak dostępu">Ten widok jest dostępny dla administratora.</Banner>;

  return (
    <>
      <PageHeader
        title="Działy"
        actions={<button type="button" className="btn btn-primary" onClick={() => setEditing("new")}><Plus size={16} />Nowy dział</button>}
      />
      <Card>
        {departments.isPending && <Loading />}
        {departments.error && <Banner tone="danger" title="Nie udało się wczytać działów">{errorText(departments.error)}</Banner>}
        {departments.data && !departments.data.length && <EmptyState title="Brak działów" />}
        {departments.data && departments.data.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Dział</th><th>Kierownik</th><th className="num">Osoby</th><th>Status</th><th /></tr></thead>
              <tbody>
                {departments.data.map((department) => (
                  <tr key={department.id}>
                    <td data-label="Dział"><strong>{department.name}</strong><small className="muted">{department.code}</small></td>
                    <td data-label="Kierownik">{fullName(department.manager)}</td>
                    <td data-label="Osoby" className="num">{department._count?.users ?? 0}</td>
                    <td data-label="Status"><Badge tone={department.isActive ? "success" : "neutral"}>{department.isActive ? "Aktywny" : "Nieaktywny"}</Badge></td>
                    <td className="row-actions"><button type="button" className="btn btn-sm" onClick={() => setEditing(department)}>Edytuj</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && <DepartmentDialog department={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </>
  );
}
