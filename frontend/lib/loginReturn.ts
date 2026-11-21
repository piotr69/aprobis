// Bez importów: plik testuje też backendowy vitest.

/** Po logowaniu wolno wrócić wyłącznie na kartę dokumentu; każda inna wartość jest ignorowana. */
export function safeReturnPath(value: string | null | undefined): string | null {
  return value && /^\/documents\/[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

/** Adres logowania, który po zalogowaniu wróci na kartę dokumentu z bieżącej strony. */
export function loginPathFrom(pathname: string) {
  const target = safeReturnPath(pathname);
  return target ? `/login?${new URLSearchParams({ next: target })}` : "/login";
}
