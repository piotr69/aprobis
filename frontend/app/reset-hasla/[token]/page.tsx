"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Banner, ErrorBanner, Field } from "@/components/ui";
import { post } from "@/lib/api";

const MIN_LENGTH = 8;

export default function ResetConfirmPage() {
  const { token } = useParams<{ token: string }>();
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== repeat) {
      setError(new Error("Hasła nie są takie same"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post("/auth/password-reset/confirm", { token, password });
      setDone(true);
    } catch (confirmError) {
      setError(confirmError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center-screen">
      <section className="center-card">
        <div className="brand brand-large">
          <span className="brand-mark" aria-hidden="true">A</span>
          <div>
            <strong>Nowe hasło</strong>
            <small>Ustaw hasło do swojego konta</small>
          </div>
        </div>
        {done ? (
          <>
            <Banner tone="success" title="Hasło zostało zmienione">Możesz zalogować się nowym hasłem.</Banner>
            <Link href="/login" className="btn btn-primary btn-block">Przejdź do logowania</Link>
          </>
        ) : (
          <form className="stack" onSubmit={submit}>
            <ErrorBanner error={error} />
            <Field label="Nowe hasło" required hint={`Co najmniej ${MIN_LENGTH} znaków.`}>
              <input type="password" value={password} minLength={MIN_LENGTH} maxLength={128} autoComplete="new-password" autoFocus required onChange={(event) => setPassword(event.target.value)} />
            </Field>
            <Field label="Powtórz nowe hasło" required>
              <input type="password" value={repeat} minLength={MIN_LENGTH} maxLength={128} autoComplete="new-password" required onChange={(event) => setRepeat(event.target.value)} />
            </Field>
            <button className="btn btn-primary btn-block" type="submit" disabled={busy}>{busy ? "Zapisywanie…" : "Ustaw hasło"}</button>
            <Link href="/reset-hasla" className="center-link">Poproś o nowy link</Link>
          </form>
        )}
      </section>
    </main>
  );
}
