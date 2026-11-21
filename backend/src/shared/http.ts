import type { NextFunction, Request, Response } from "express";
import { ZodError, ZodIssueCode, z, type ZodErrorMap } from "zod";
import { logger } from "./logger.js";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}

/** Domyślne komunikaty Zod po polsku: użytkownik widzi je wprost w formularzu. */
const polishErrorMap: ZodErrorMap = (issue, context) => {
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      return { message: issue.received === "undefined" ? "To pole jest wymagane" : "Nieprawidłowy format danych" };
    case ZodIssueCode.too_small:
      if (issue.type !== "string") return { message: `Minimalna wartość to ${issue.minimum}` };
      return { message: issue.minimum === 1 ? "To pole jest wymagane" : `Wpisz co najmniej ${issue.minimum} znaki` };
    case ZodIssueCode.too_big:
      return { message: issue.type === "string" ? `Wpisz najwyżej ${issue.maximum} znaków` : `Maksymalna wartość to ${issue.maximum}` };
    case ZodIssueCode.invalid_string:
      return { message: issue.validation === "email" ? "Nieprawidłowy adres e-mail" : "Nieprawidłowy format" };
    case ZodIssueCode.invalid_enum_value:
      return { message: "Wybierz wartość z listy" };
    case ZodIssueCode.invalid_date:
      return { message: "Nieprawidłowa data" };
    default:
      return { message: context.defaultError };
  }
};
z.setErrorMap(polishErrorMap);

export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function requireParam(value: string | string[] | undefined, name: string) {
  if (!value) {
    throw new AppError(400, `Brak wymaganego parametru: ${name}`);
  }
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

/**
 * Błąd zgłoszony przez body-parser przy wczytywaniu ciała żądania
 * (uszkodzony JSON, przekroczony limit rozmiaru, zły charset).
 *
 * To wina klienta, nie serwera — bez tego rozpoznania każde takie żądanie
 * kończyło się „Internal server error" z kodem 500 na dowolnym endpoincie.
 */
function asBodyParseError(error: unknown) {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { type?: unknown; status?: unknown; message?: unknown };
  if (typeof candidate.type !== "string" || !candidate.type.startsWith("entity.")) return null;
  const status = typeof candidate.status === "number" && candidate.status >= 400 && candidate.status < 500
    ? candidate.status
    : 400;
  return { status, type: candidate.type, message: typeof candidate.message === "string" ? candidate.message : "" };
}

/** Błędy bazy wynikające z danych klienta lub współbieżności: to nie są awarie serwera. */
const prismaClientErrors: Record<string, { status: number; message: string }> = {
  P2002: { status: 409, message: "Taka wartość już istnieje. Użyj innej" },
  P2003: { status: 400, message: "Wskazany powiązany rekord nie istnieje" },
  P2025: { status: 404, message: "Nie znaleziono rekordu" },
  P2034: { status: 409, message: "Ktoś właśnie zmienił te dane. Spróbuj ponownie" }
};

function asPrismaClientError(error: unknown) {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { name?: unknown; code?: unknown };
  if (candidate.name !== "PrismaClientKnownRequestError" || typeof candidate.code !== "string") return null;
  return prismaClientErrors[candidate.code] ?? null;
}

function asUploadError(error: unknown) {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { name?: unknown; code?: unknown };
  if (candidate.name !== "MulterError") return null;
  return candidate.code === "LIMIT_FILE_SIZE"
    ? { status: 413, message: "Plik jest za duży. Limit to 25 MB" }
    : { status: 400, message: "Nie udało się przyjąć pliku" };
}

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction) {
  const bodyParseError = asBodyParseError(error);
  if (bodyParseError) {
    return res.status(bodyParseError.status).json({
      message: bodyParseError.type === "entity.too.large"
        ? "Request body is too large"
        : "Malformed request body",
      details: { type: bodyParseError.type, reason: bodyParseError.message }
    });
  }

  if (error instanceof ZodError) {
    return res.status(400).json({
      message: "Popraw dane formularza",
      details: { issues: error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })) }
    });
  }

  if (error instanceof AppError) {
    return res.status(error.statusCode).json({
      message: error.message,
      details: error.details
    });
  }

  const known = asPrismaClientError(error) ?? asUploadError(error);
  if (known) return res.status(known.status).json({ message: known.message });

  logger.error("Unhandled request error", {
    correlationId: req.correlationId,
    method: req.method,
    path: req.path,
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error)
  });
  return res.status(500).json({ message: "Internal server error" });
}
