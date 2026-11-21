import type { NextFunction, Request, Response } from "express";
import { logger } from "./logger.js";
import { prisma } from "./prisma.js";

type RateLimitOptions = {
  windowMs: number;
  max: number;
  message?: string;
  /** Klucz licznika; domyślnie ścieżka i adres klienta. */
  key?: (req: Request) => string;
};

export function rateLimit({ windowMs, max, message = "Too many requests", key: keyOf }: RateLimitOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const now = Date.now();
      const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
      const expiresAt = new Date(windowStart.getTime() + windowMs);
      const key = keyOf ? keyOf(req) : `${req.path}:${req.ip ?? "unknown"}`.slice(0, 200);
      const bucket = await prisma.rateLimitBucket.upsert({
        where: { key_windowStart: { key, windowStart } },
        create: { key, windowStart, count: 1, expiresAt },
        update: { count: { increment: 1 } }
      });

      if (Math.random() < 0.01) {
        // Sprzątanie starych okien jest best-effort — nieobsłużony reject kończy proces.
        void prisma.rateLimitBucket
          .deleteMany({ where: { expiresAt: { lt: new Date() } } })
          .catch((error: unknown) => {
            logger.warn("Nie udało się wyczyścić wygasłych okien rate limitu", {
              error: error instanceof Error ? error.message : String(error)
            });
          });
      }
      if (bucket.count > max) {
        res.setHeader("Retry-After", String(Math.max(1, Math.ceil((expiresAt.getTime() - now) / 1000))));
        return res.status(429).json({ message });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
