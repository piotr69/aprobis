import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { ZodError, z } from "zod";
import { AppError, errorHandler } from "../src/shared/http.js";

vi.mock("../src/shared/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

function fakeExchange() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return {
    req: { correlationId: "cid", method: "POST", path: "/api/workflow/tasks/x/decision" } as unknown as Request,
    res: { status } as unknown as Response,
    next: vi.fn() as unknown as NextFunction,
    status,
    json
  };
}

/** Kształt błędu, jaki body-parser podaje do middleware'u błędów. */
function bodyParserError(type: string, status: number, message: string) {
  return Object.assign(new SyntaxError(message), { type, status, statusCode: status, expose: true });
}

describe("errorHandler", () => {
  it("zwraca 400 dla uszkodzonego JSON-a w ciele żądania", () => {
    // Wcześniej SyntaxError z body-parsera nie był rozpoznawany i każdy endpoint
    // odpowiadał 500 „Internal server error".
    const { req, res, next, status, json } = fakeExchange();

    errorHandler(bodyParserError("entity.parse.failed", 400, "Unexpected token '}'"), req, res, next);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ message: "Malformed request body" }));
  });

  it("zwraca 413 dla zbyt dużego ciała żądania", () => {
    const { req, res, next, status, json } = fakeExchange();

    errorHandler(bodyParserError("entity.too.large", 413, "request entity too large"), req, res, next);

    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ message: "Request body is too large" }));
  });

  it("nie myli zwykłego SyntaxError z błędem parsowania ciała", () => {
    // SyntaxError z logiki aplikacji to nadal błąd serwera.
    const { req, res, next, status, json } = fakeExchange();

    errorHandler(new SyntaxError("coś poszło nie tak w kodzie"), req, res, next);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ message: "Internal server error" });
  });

  it("nadal mapuje ZodError na 400", () => {
    const { req, res, next, status } = fakeExchange();
    const zodError = z.object({ a: z.string() }).safeParse({ a: 1 }).error as ZodError;

    errorHandler(zodError, req, res, next);

    expect(status).toHaveBeenCalledWith(400);
  });

  it("nadal honoruje statusCode z AppError", () => {
    const { req, res, next, status, json } = fakeExchange();

    errorHandler(new AppError(403, "Nie możesz podejmować decyzji o własnym dokumencie"), req, res, next);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      message: "Nie możesz podejmować decyzji o własnym dokumencie"
    }));
  });
});
