"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { ApiError, errorText } from "@/lib/api";
import { Banner } from "@/components/ui";
import { loginPathFrom } from "@/lib/loginReturn";
import { useProfile } from "@/lib/queries";

function Centered({ children }: { children: ReactNode }) {
  return (
    <main className="center-screen">
      <section className="center-card">
        <div className="brand brand-large">
          <span className="brand-mark" aria-hidden="true">A</span>
          <div><strong>Aprobis</strong></div>
        </div>
        {children}
      </section>
    </main>
  );
}

/** Bramka aplikacji: niezalogowanych odsyła do logowania. */
export default function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: me, error, isPending, refetch } = useProfile();
  const unauthorized = error instanceof ApiError && error.status === 401;

  useEffect(() => {
    if (unauthorized) router.replace(loginPathFrom(pathname));
  }, [unauthorized, router, pathname]);

  if (isPending || unauthorized) return <Centered><p className="loading">Wczytywanie…</p></Centered>;

  if (error || !me) {
    return (
      <Centered>
        <Banner tone="danger" title="Nie udało się połączyć z aplikacją">{errorText(error)}</Banner>
        <button type="button" className="btn btn-primary btn-block" onClick={() => refetch()}>Spróbuj ponownie</button>
      </Centered>
    );
  }

  return <AppShell>{children}</AppShell>;
}
