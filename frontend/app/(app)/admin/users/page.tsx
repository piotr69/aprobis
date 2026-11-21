"use client";

import { Plus, Search } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Badge, Banner, Card, EmptyState, ErrorBanner, Field, Loading, Modal, PageHeader } from "@/components/ui";
import { useToast } from "@/components/ui/toast";
import { errorText, patch, post } from "@/lib/api";
import { fullName, money } from "@/lib/format";
import { useDepartments, useMe, usePositions, useRoles, useUsers } from "@/lib/queries";
import type { DirectoryUser } from "@/lib/types";

const MIN_PASSWORD = 8;

function generatePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789#%+=";
  const values = crypto.getRandomValues(new Uint32Array(16));
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
}

function UserDialog({ user, onClose }: { user?: DirectoryUser; onClose: () => void }) {
  const me = useMe();
  const client = useQueryClient();
  const toast = useToast();
  const users = useUsers();
  const departments = useDepartments();
  const positions = usePositions();
  const roles = useRoles();
  const isSelf = user?.id === me.id;
  const [firstName, setFirstName] = useState(user?.firstName ?? "");
  const [lastName, setLastName] = useState(user?.lastName ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [login, setLogin] = useState(user?.login ?? "");
  const hadLimit = user?.approvalLimitAmount !== null && user?.approvalLimitAmount !== undefined;
  const [limitOn, setLimitOn] = useState(hadLimit);
  const [limitAmount, setLimitAmount] = useState(hadLimit ? String(user!.approvalLimitAmount) : "");
  const [limitCurrency, setLimitCurrency] = useState(user?.approvalLimitCurrency ?? "PLN");
  const [role, setRole] = useState(user?.role ?? "EMPLOYEE");
  const [departmentId, setDepartmentId] = useState(user?.department?.id ?? "");
  const [positionId, setPositionId] = useState(user?.position?.id ?? "");
  const [managerId, setManagerId] = useState(user?.manager?.id ?? "");
  const [isActive, setIsActive] = useState(user?.isActive ?? true);
  const [password, setPassword] = useState(user ? "" : generatePassword());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<string | null>(null);
  const selectedRole = roles.data?.find((item) => item.role === role);

  async function save() {
    if (limitOn && !limitAmount.trim()) {
      setError(new Error("Wpisz kwotę limitu albo wyłącz limit"));
      return;
    }
    setBusy(true);
    setError(null);
    const body = {
      firstName, lastName, email, role,
      login: login.trim() || null,
      approvalLimitAmount: limitOn ? limitAmount.trim().replace(",", ".") : null,
      approvalLimitCurrency: limitCurrency,
      departmentId: departmentId || null,
      positionId: positionId || null,
      managerId: managerId || null,
      isActive,
      ...(password ? { password } : {})
    };
    try {
      if (user) await patch(`/users/${user.id}`, body);
      else await post("/users", body);
      await client.invalidateQueries({ queryKey: ["users"] });
      if (password) {
        // Hasło pokazujemy raz: w bazie jest tylko jego skrót.
        setCreated(password);
      } else {
        toast.success("Zapisano zmiany");
        onClose();
      }
    } catch (saveError) {
      setError(saveError);
    } finally {
      setBusy(false);
    }
  }

  async function unlock() {
    try {
      await patch(`/users/${user!.id}`, { unlock: true });
      await client.invalidateQueries({ queryKey: ["users"] });
      toast.success("Konto odblokowane");
      onClose();
    } catch (unlockError) {
      setError(unlockError);
    }
  }

  if (created) {
    return (
      <Modal title="Przekaż hasło użytkownikowi" onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Gotowe</button>}>
        <div className="stack">
          <p>To hasło widać tylko teraz. Przekaż je bezpiecznie. Użytkownik może je zmienić w „Moje konto”.</p>
          <code className="secret">{created}</code>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      size="lg"
      title={user ? `Edycja: ${fullName(user)}` : "Nowy użytkownik"}
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
        <div className="form-grid">
          <Field label="Imię" required><input value={firstName} onChange={(event) => setFirstName(event.target.value)} /></Field>
          <Field label="Nazwisko"><input value={lastName} onChange={(event) => setLastName(event.target.value)} /></Field>
          <Field label="E-mail" required hint="Na ten adres przyjdzie link do nowego hasła."><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></Field>
          <Field label="Login" hint="Można logować się loginem albo e-mailem."><input value={login} maxLength={60} onChange={(event) => setLogin(event.target.value)} /></Field>
          <Field label="Rola" required wide hint={selectedRole?.description}>
            <select value={role} disabled={isSelf} onChange={(event) => setRole(event.target.value)}>
              {(roles.data ?? []).map((item) => <option key={item.role} value={item.role}>{item.label}</option>)}
            </select>
          </Field>
          <Field label="Dział" hint="Decyduje o tym, kto jest kierownikiem działu dla dokumentów tej osoby.">
            <select value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}>
              <option value="">Brak</option>
              {(departments.data ?? []).map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
            </select>
          </Field>
          <Field label="Stanowisko">
            <select value={positionId} onChange={(event) => setPositionId(event.target.value)}>
              <option value="">Brak</option>
              {(positions.data ?? []).map((position) => <option key={position.id} value={position.id}>{position.name}</option>)}
            </select>
          </Field>
          <Field label="Przełożony" wide hint="Akceptuje dokumenty tej osoby. Bez przełożonego dokumenty trafiają do zarządu.">
            <select value={managerId} onChange={(event) => setManagerId(event.target.value)}>
              <option value="">Brak</option>
              {(users.data ?? []).filter((item) => item.isActive && item.id !== user?.id).map((item) => <option key={item.id} value={item.id}>{fullName(item)}</option>)}
            </select>
          </Field>
          <Field label={user ? "Nowe hasło" : "Hasło początkowe"} wide hint={`Co najmniej ${MIN_PASSWORD} znaków.${user ? " Puste: bez zmiany." : ""}`}>
            <div className="input-with-button">
              <input value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" />
              <button type="button" className="btn" onClick={() => setPassword(generatePassword())}>Wygeneruj</button>
            </div>
          </Field>
        </div>
        <h3>Limit akceptacji</h3>
        <label className="check">
          <input type="checkbox" checked={limitOn} onChange={(event) => setLimitOn(event.target.checked)} />
          Ta osoba ma limit kwoty, do której może zatwierdzać
        </label>
        {limitOn && (
          <Field label="Najwyższa kwota" required hint="Dokument powyżej limitu trafi do przełożonego tej osoby. Limit w innej walucie niż dokument liczy się jako przekroczony.">
            <div className="limit-field">
              <input type="number" min="0" step="0.01" value={limitAmount} onChange={(event) => setLimitAmount(event.target.value)} />
              <select aria-label="Waluta limitu" value={limitCurrency} onChange={(event) => setLimitCurrency(event.target.value)}>
                <option value="PLN">PLN</option>
                <option value="EUR">EUR</option>
                <option value="USD">USD</option>
              </select>
            </div>
          </Field>
        )}
        <h3>Konto</h3>
        <label className="check">
          <input type="checkbox" checked={isActive} disabled={isSelf} onChange={(event) => setIsActive(event.target.checked)} />
          Konto aktywne
        </label>
        {user?.lockedAt && (
          <div className="comment-actions">
            <span className="text-danger">Konto jest zablokowane po nieudanych próbach logowania. Blokada wygasa po 15 minutach.</span>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={unlock}>Odblokuj teraz</button>
          </div>
        )}
        {isSelf && <p className="muted small">Własnej roli ani aktywności konta nie można zmienić: firma mogłaby stracić dostęp do administracji.</p>}
      </div>
    </Modal>
  );
}

export default function UsersPage() {
  const me = useMe();
  const users = useUsers();
  const roles = useRoles();
  const [phrase, setPhrase] = useState("");
  const [editing, setEditing] = useState<DirectoryUser | "new" | null>(null);

  const filtered = useMemo(() => {
    const needle = phrase.trim().toLocaleLowerCase("pl-PL");
    return (users.data ?? []).filter((user) => !needle || `${fullName(user)} ${user.email ?? ""} ${user.login ?? ""} ${user.department?.name ?? ""}`.toLocaleLowerCase("pl-PL").includes(needle));
  }, [users.data, phrase]);

  if (!me.capabilities.manageUsers) return <Banner tone="danger" title="Brak dostępu">Ten widok jest dostępny dla administratora.</Banner>;

  const roleLabel = (role: string) => roles.data?.find((item) => item.role === role)?.label ?? role;

  return (
    <>
      <PageHeader
        title="Użytkownicy"
        description="Konta, role i przełożeni. Przełożony decyduje o tym, dokąd trafiają dokumenty danej osoby."
        actions={<button type="button" className="btn btn-primary" onClick={() => setEditing("new")}><Plus size={16} />Nowy użytkownik</button>}
      />
      <Card>
        <div className="toolbar">
          <div className="search-input">
            <Search size={16} aria-hidden="true" />
            <input type="search" aria-label="Szukaj użytkownika" placeholder="Szukaj po nazwisku, e-mailu lub dziale" value={phrase} onChange={(event) => setPhrase(event.target.value)} />
          </div>
        </div>
        {users.isPending && <Loading />}
        {users.error && <Banner tone="danger" title="Nie udało się wczytać użytkowników">{errorText(users.error)}</Banner>}
        {users.data && !filtered.length && <EmptyState title="Nie znaleziono użytkowników" />}
        {filtered.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Osoba</th><th>Rola</th><th>Dział</th><th>Przełożony</th><th>Limit</th><th>Status</th><th /></tr></thead>
              <tbody>
                {filtered.map((user) => (
                  <tr key={user.id}>
                    <td data-label="Osoba"><strong>{fullName(user)}</strong><small className="muted">{user.login ? `${user.login} · ` : ""}{user.email}</small></td>
                    <td data-label="Rola">{roleLabel(user.role)}</td>
                    <td data-label="Dział">{user.department?.name ?? "—"}</td>
                    <td data-label="Przełożony">{fullName(user.manager)}</td>
                    <td data-label="Limit">{user.approvalLimitAmount === null || user.approvalLimitAmount === undefined ? <span className="muted">Bez limitu</span> : money(user.approvalLimitAmount, user.approvalLimitCurrency)}</td>
                    <td data-label="Status">
                      {user.lockedAt
                        ? <Badge tone="danger">Zablokowane</Badge>
                        : <Badge tone={user.isActive ? "success" : "neutral"}>{user.isActive ? "Aktywne" : "Nieaktywne"}</Badge>}
                    </td>
                    <td className="row-actions"><button type="button" className="btn btn-sm" onClick={() => setEditing(user)}>Edytuj</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Co oznaczają role">
        <dl className="role-list">
          {(roles.data ?? []).map((role) => (
            <div key={role.role}><dt>{role.label}</dt><dd>{role.description}</dd></div>
          ))}
        </dl>
      </Card>
      {editing && <UserDialog user={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    </>
  );
}
