"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { post } from "@/lib/api";
import { safeReturnPath } from "@/lib/loginReturn";
import { ErrorBanner, Field } from "@/components/ui";

export function LoginScreen() {
  const router = useRouter();
  const client = useQueryClient();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/auth/login", { identifier, password });
      client.clear();
      router.replace(safeReturnPath(new URLSearchParams(window.location.search).get("next")) ?? "/");
    } catch (loginError) {
      setError(loginError);
      setBusy(false);
    }
  }

  return (
    <main className="center-screen">
      <section className="center-card">
        <div className="brand brand-large">
          <span className="brand-mark" aria-hidden="true">A</span>
          <div>
            <strong>Aprobis</strong>
            <small>Zaloguj się, aby kontynuować</small>
          </div>
        </div>
        <form className="stack" onSubmit={handleSubmit}>
          <ErrorBanner error={error} />
          <Field label="Login lub e-mail">
            <input value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="username" autoFocus required />
          </Field>
          <Field label="Hasło">
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" required />
          </Field>
          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>{busy ? "Logowanie…" : "Zaloguj"}</button>
          <Link href="/reset-hasla" className="center-link">Nie pamiętam hasła</Link>
        </form>
      </section>
    </main>
  );
}
