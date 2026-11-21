import express from "express";
import { randomUUID } from "node:crypto";
import cors from "cors";
import helmet from "helmet";
import { env } from "./config/env.js";
import { AppError, errorHandler } from "./shared/http.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { userRouter } from "./modules/users/users.routes.js";
import { organizationRouter } from "./modules/organization/organization.routes.js";
import { documentRouter } from "./modules/documents/documents.routes.js";
import { documentTypeRouter } from "./modules/document-types/document-types.routes.js";
import { workflowRouter } from "./modules/workflow/workflow.routes.js";
import { rulesRouter } from "./modules/rules/rules.routes.js";
import { reportsRouter } from "./modules/reports/reports.routes.js";
import { auditRouter } from "./modules/audit/audit.routes.js";
import { systemLogRouter } from "./modules/system-logs/system-logs.routes.js";
import { configRouter } from "./modules/config/config.routes.js";
import { notificationRouter } from "./modules/notifications/notifications.routes.js";
import { scannerMode } from "./modules/files/antivirus.js";

export function createApp() {
  const app = express();

  // Bez tego za reverse proxy req.ip to adres proxy: rate limit logowania
  // (10/15 min) obejmowałby wszystkich użytkowników łącznie, a audyt zapisywałby
  // adres proxy zamiast klienta. Liczba przeskoków jest jawna — `true` pozwoliłoby
  // podszyć się pod dowolny adres nagłówkiem X-Forwarded-For.
  app.set("trust proxy", env.TRUST_PROXY_HOPS);

  app.use(helmet());
  app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
  app.use(express.json({ limit: "2mb" }));
  app.use((req, res, next) => {
    req.correlationId = req.header("x-correlation-id")?.slice(0, 64) || randomUUID();
    res.setHeader("x-correlation-id", req.correlationId);
    next();
  });
  app.use((req, _res, next) => {
    const origin = req.header("origin");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && origin && origin !== env.FRONTEND_URL) {
      return next(new AppError(403, "Invalid request origin"));
    }
    next();
  });

  app.get("/api/health", (_req, res) => {
    // Tylko tryb skanera (bez adresów i poświadczeń): "disabled"/"unconfigured" widać od razu przy kontroli instalacji.
    res.json({ status: "ok", app: "aprobis-backend", antivirus: scannerMode() });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/users", userRouter);
  app.use("/api/organization", organizationRouter);
  app.use("/api/document-types", documentTypeRouter);
  app.use("/api/documents", documentRouter);
  app.use("/api/workflow", workflowRouter);
  app.use("/api/rules", rulesRouter);
  app.use("/api/approval-rules", rulesRouter);
  app.use("/api/reports", reportsRouter);
  app.use("/api/audit-logs", auditRouter);
  app.use("/api/system-logs", systemLogRouter);
  app.use("/api/config", configRouter);
  app.use("/api/notifications", notificationRouter);

  app.use(errorHandler);

  return app;
}
