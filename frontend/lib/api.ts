import { loginPathFrom } from "./loginReturn";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";

export type ApiIssue = { field: string; message: string };

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public issues: ApiIssue[] = [],
    public code?: string
  ) {
    super(message);
  }
}

function handleUnauthorized(response: Response, path: string) {
  // Odpowiedź 401 na próbę logowania to błędne hasło, a nie wygasła sesja.
  if (response.status === 401 && !path.startsWith("/auth/login") && typeof window !== "undefined" && window.location.pathname !== "/login") {
    window.location.assign(loginPathFrom(window.location.pathname));
  }
}

export async function apiRequestRaw(path: string, options: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${API_URL}${path}`, { ...options, credentials: "include" });
  handleUnauthorized(response, path);
  return response;
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...options,
      credentials: "include",
      headers: {
        ...(isFormData ? {} : { "Content-Type": "application/json" }),
        ...options.headers
      }
    });
  } catch {
    throw new ApiError(0, "Brak połączenia z serwerem. Sprawdź, czy aplikacja działa, i spróbuj ponownie");
  }
  handleUnauthorized(response, path);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const issues: ApiIssue[] = Array.isArray(body.details?.issues) ? body.details.issues : [];
    const message = response.status >= 500
      ? "Coś poszło nie tak po stronie serwera. Spróbuj ponownie za chwilę"
      : body.message ?? "Nie udało się wykonać operacji";
    throw new ApiError(response.status, message, issues, body.details?.code);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const post = <T>(path: string, body: unknown = {}) => apiRequest<T>(path, { method: "POST", body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown = {}) => apiRequest<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const remove = (path: string) => apiRequest<void>(path, { method: "DELETE" });

export function errorText(error: unknown, fallback = "Nie udało się wykonać operacji") {
  return error instanceof Error ? error.message : fallback;
}
