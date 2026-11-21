import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { env } from "../src/config/env.js";

describe("konfiguracja aplikacji", () => {
  it("ustawia trust proxy z konfiguracji, a nie na sztywno", () => {
    // Bez tego req.ip zwraca adres proxy — rate limit logowania obejmuje wtedy
    // wszystkich użytkowników łącznie, a audyt zapisuje adres proxy.
    expect(createApp().get("trust proxy")).toBe(env.TRUST_PROXY_HOPS);
  });

  it("domyślnie zakłada brak proxy", () => {
    // `true` byłoby niebezpieczne: pozwalałoby podszyć się pod dowolny adres
    // nagłówkiem X-Forwarded-For.
    expect(createApp().get("trust proxy")).not.toBe(true);
  });

  it("wystawia health check bez uwierzytelnienia", () => {
    const app = createApp();
    const routes = app.router.stack
      .filter((layer: { route?: { path: string } }) => layer.route)
      .map((layer: { route?: { path: string } }) => layer.route!.path);
    expect(routes).toContain("/api/health");
  });
});
