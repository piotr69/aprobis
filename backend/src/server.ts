import { createApp } from "./app.js";
import { env, logRoot } from "./config/env.js";
import { syncAppVersion } from "./shared/appVersion.js";
import { configureLogger, drainLogs, logger } from "./shared/logger.js";

configureLogger({ source: "api", directory: logRoot, persist: true, quietConsole: env.NODE_ENV === "production" });

const app = createApp();
void syncAppVersion();

app.listen(env.PORT, env.HOST ?? "", () => {
  console.log(`Aprobis API listening on http://localhost:${env.PORT}/api`);
  logger.info("API uruchomione", { port: env.PORT });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void drainLogs().finally(() => process.exit(0)); });
}
