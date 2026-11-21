"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Banner, ErrorBanner, Field } from "@/components/ui";
import { post } from "@/lib/api";

export default function ResetRequestPage() {
  const [identifier, setIdentifier] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/auth/password-reset", { identifier });
      setSent(true);
    } catch (requestError) {
      setError(requestError);
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
            <strong>Nie pamiętam hasła</strong>
            <small>Wyślemy Ci link do ustawienia nowego</small>
          </div>
        </div>
        {sent ? (
          <Banner tone="success" title="Sprawdź skrzynkę pocztową">
            Jeśli takie konto istnieje, wysłaliśmy na przypisany do niego e-mail link do ustawienia nowego hasła. Link jest ważny przez 1 godzinę.
          </Banner>
        ) : (
          <form className="stack" onSubmit={submit}>
            <ErrorBanner error={error} />
            <Field label="Login lub e-mail">
              <input value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="username" autoFocus required />
            </Field>
            <button className="btn btn-primary btn-block" type="submit" disabled={busy}>{busy ? "Wysyłanie…" : "Wyślij link"}</button>
          </form>
        )}
        <Link href="/login" className="center-link">Wróć do logowania</Link>
      </section>
    </main>
  );
}
