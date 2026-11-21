"use client";

import { Trash2 } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { ChangePasswordForm } from "@/components/account/ChangePasswordForm";
import { Card, EmptyState, ErrorBanner, Field, PageHeader } from "@/components/ui";
import { useToast } from "@/components/ui/toast";
import { apiRequest, errorText, post, remove } from "@/lib/api";
import { date, fullName, money } from "@/lib/format";
import { useMe, useUsers } from "@/lib/queries";
import type { Substitution } from "@/lib/types";

function today() {
  return new Date().toISOString().slice(0, 10);
}

function Substitutions() {
  const me = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const users = useUsers();
  const list = useQuery({ queryKey: ["substitutions"], queryFn: () => apiRequest<Substitution[]>("/organization/substitutions") });
  const [substitute, setSubstitute] = useState("");
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/organization/substitutions", {
        substituteUserId: substitute,
        validFrom: new Date(`${from}T00:00:00`).toISOString(),
        validTo: new Date(`${to}T23:59:59`).toISOString()
      });
      setSubstitute("");
      setTo("");
      await client.invalidateQueries({ queryKey: ["substitutions"] });
      toast.success("Zastępstwo zapisane");
    } catch (addError) {
      setError(addError);
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    try {
      await remove(`/organization/substitutions/${id}`);
      await client.invalidateQueries({ queryKey: ["substitutions"] });
    } catch (cancelError) {
      toast.error(errorText(cancelError));
    }
  }

  const items = (list.data ?? []).filter((item) => item.userId === me.id || item.substituteUserId === me.id);

  return (
    <Card title="Zastępstwa">
      <p className="muted small">Idziesz na urlop? Wskaż zastępcę: w tym czasie zobaczy Twoje zadania i będzie mógł w nich decydować. Decyzje zapiszą się z adnotacją o zastępstwie.</p>
      {items.length > 0 ? (
        <ul className="plain-list">
          {items.map((item) => (
            <li key={item.id}>
              <span>
                {item.userId === me.id
                  ? <>Zastępuje Cię: <strong>{fullName(item.substituteUser)}</strong></>
                  : <>Zastępujesz: <strong>{fullName(item.user)}</strong></>}
                <small className="muted"> {date(item.validFrom)} – {date(item.validTo)}</small>
              </span>
              {item.userId === me.id && (
                <button type="button" className="icon-btn" aria-label="Odwołaj zastępstwo" onClick={() => cancel(item.id)}><Trash2 size={16} /></button>
              )}
            </li>
          ))}
        </ul>
      ) : <EmptyState title="Brak aktywnych zastępstw" />}
      <form className="stack" onSubmit={add}>
        <ErrorBanner error={error} />
        <div className="form-grid">
          <Field label="Zastępca" required wide>
            <select value={substitute} onChange={(event) => setSubstitute(event.target.value)} required>
              <option value="">Wybierz osobę…</option>
              {(users.data ?? []).filter((user) => user.isActive && user.id !== me.id).map((user) => (
                <option key={user.id} value={user.id}>{fullName(user)}{user.department ? ` · ${user.department.name}` : ""}</option>
              ))}
            </select>
          </Field>
          <Field label="Od" required><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} required /></Field>
          <Field label="Do" required><input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} required /></Field>
        </div>
        <div><button type="submit" className="btn" disabled={busy}>Dodaj zastępstwo</button></div>
      </form>
    </Card>
  );
}

export default function AccountPage() {
  const me = useMe();
  return (
    <>
      <PageHeader title="Moje konto" />
      <div className="two-columns">
        <div className="stack-lg">
          <Card title="Dane">
            <dl className="details">
              <div><dt>Imię i nazwisko</dt><dd>{fullName(me)}</dd></div>
              <div><dt>Login</dt><dd>{me.login ?? "—"}</dd></div>
              <div><dt>E-mail</dt><dd>{me.email}</dd></div>
              <div><dt>Limit akceptacji</dt><dd>{me.approvalLimitAmount === null || me.approvalLimitAmount === undefined ? "Bez limitu" : money(me.approvalLimitAmount, me.approvalLimitCurrency)}</dd></div>
              <div><dt>Rola</dt><dd>{me.roleLabel}</dd></div>
              <div><dt>Dział</dt><dd>{me.department?.name ?? "—"}</dd></div>
              <div><dt>Stanowisko</dt><dd>{me.position?.name ?? "—"}</dd></div>
              <div><dt>Przełożony</dt><dd>{fullName(me.manager)}</dd></div>
            </dl>
          </Card>
          <Substitutions />
        </div>
        <Card title="Zmiana hasła"><ChangePasswordForm /></Card>
      </div>
    </>
  );
}
