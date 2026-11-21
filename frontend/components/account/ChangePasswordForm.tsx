"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { post } from "@/lib/api";
import { ErrorBanner, Field } from "@/components/ui";
import { useToast } from "@/components/ui/toast";

const MIN_LENGTH = 8;

export function ChangePasswordForm() {
  const client = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (next !== repeat) {
      setError(new Error("Nowe hasła nie są takie same"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post("/auth/change-password", { currentPassword: current, newPassword: next });
      // Zmiana hasła kończy wszystkie sesje, także tę: logujemy się nowym hasłem.
      toast.success("Hasło zostało zmienione. Zaloguj się ponownie");
      client.clear();
      router.replace("/login");
    } catch (changeError) {
      setError(changeError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <ErrorBanner error={error} />
      <Field label="Obecne hasło" required>
        <input type="password" value={current} onChange={(event) => setCurrent(event.target.value)} autoComplete="current-password" required />
      </Field>
      <Field label="Nowe hasło" required hint={`Co najmniej ${MIN_LENGTH} znaków.`}>
        <input type="password" value={next} onChange={(event) => setNext(event.target.value)} autoComplete="new-password" minLength={MIN_LENGTH} required />
      </Field>
      <Field label="Powtórz nowe hasło" required>
        <input type="password" value={repeat} onChange={(event) => setRepeat(event.target.value)} autoComplete="new-password" minLength={MIN_LENGTH} required />
      </Field>
      <div>
        <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Zapisywanie…" : "Zmień hasło"}</button>
      </div>
    </form>
  );
}
