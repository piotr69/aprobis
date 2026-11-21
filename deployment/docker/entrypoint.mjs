import { spawn } from "node:child_process";
import { databaseSettings, databaseUrl, secret } from "./settings.mjs";

async function main() {
  const mode = process.argv[2];
  const commands = {
    api: ["backend/dist/server.js"],
    worker: ["backend/dist/worker.js"],
    web: ["node_modules/next/dist/bin/next", "start", "frontend", "--hostname", "0.0.0.0", "--port", "3000"],
    migrate: ["deployment/docker/initialize.mjs"]
  };
  if (!Object.hasOwn(commands, mode)) throw new Error("Expected api, worker, web or migrate");
  if (mode === "api" || mode === "worker") {
    const settings = databaseSettings();
    process.env.DATABASE_URL = databaseUrl(settings, settings.login, secret(process.env.SQL_APP_PASSWORD_FILE, "SQL app password"));
  }
  const child = spawn(process.execPath, commands[mode], { stdio: "inherit", env: process.env });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
  child.on("error", () => { console.error("Could not start application process"); process.exitCode = 1; });
  child.on("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGTERM" ? 0 : 1); });
}

main().catch(() => {
  // Connection errors must not echo a datasource or a password.
  console.error("Container configuration is invalid. Check the selected command, SQL settings and secret files.");
  process.exitCode = 1;
});
