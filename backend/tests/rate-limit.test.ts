import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.fn();
const deleteMany = vi.fn();

const warn = vi.fn();

vi.mock("../src/shared/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: (...args: unknown[]) => warn(...args), error: vi.fn() }
}));

vi.mock("../src/shared/prisma.js", () => ({
  prisma: {
    rateLimitBucket: {
      upsert: (...args: unknown[]) => upsert(...args),
      deleteMany: (...args: unknown[]) => deleteMany(...args)
    }
  }
}));

const { rateLimit } = await import("../src/shared/rateLimit.js");

function fakeRequest() {
  return { path: "/login", ip: "203.0.113.7" } as unknown as Request;
}

function fakeResponse() {
  const json = vi.fn();
  return {
    response: { setHeader: vi.fn(), status: vi.fn(() => ({ json })) } as unknown as Response,
    json
  };
}

/** Oddaje sterowanie pętli zdarzeń, żeby domknęły się promisy best-effort. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("rateLimit", () => {
  beforeEach(() => {
    upsert.mockReset();
    deleteMany.mockReset();
    warn.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("przepuszcza żądanie poniżej limitu", async () => {
    upsert.mockResolvedValue({ count: 3 });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const next = vi.fn() as unknown as NextFunction;

    await rateLimit({ windowMs: 60_000, max: 10 })(fakeRequest(), fakeResponse().response, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("odrzuca żądanie powyżej limitu z nagłówkiem Retry-After", async () => {
    upsert.mockResolvedValue({ count: 11 });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { response, json } = fakeResponse();
    const next = vi.fn() as unknown as NextFunction;

    await rateLimit({ windowMs: 60_000, max: 10, message: "za dużo" })(fakeRequest(), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String));
    expect(json).toHaveBeenCalledWith({ message: "za dużo" });
  });

  it("obsługuje błąd sprzątania wygasłych okien, zamiast zostawić wiszące odrzucenie", async () => {
    upsert.mockResolvedValue({ count: 1 });
    deleteMany.mockRejectedValue(new Error("baza niedostępna"));
    // random < 0.01 uruchamia gałąź sprzątającą.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const next = vi.fn() as unknown as NextFunction;

    await rateLimit({ windowMs: 60_000, max: 10 })(fakeRequest(), fakeResponse().response, next);
    await flush();

    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    // Wpis w logu dowodzi, że odrzucenie ma właściciela — bez .catch() promise wisi
    // i Node.js kończy proces na unhandledRejection.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({ error: "baza niedostępna" });
  });

  it("przekazuje błąd upsertu do next(), zamiast go gubić", async () => {
    upsert.mockRejectedValue(new Error("deadlock"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const next = vi.fn() as unknown as NextFunction;

    await rateLimit({ windowMs: 60_000, max: 10 })(fakeRequest(), fakeResponse().response, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});
