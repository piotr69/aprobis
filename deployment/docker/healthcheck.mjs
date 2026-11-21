import { readFileSync, statSync } from "node:fs";

try {
  const mode = process.argv[2];
  if (mode === "worker") {
    const file = process.env.WORKER_HEARTBEAT_FILE;
    if (!file || !readFileSync(file, "utf8") || Date.now() - statSync(file).mtimeMs > 300_000) throw new Error();
  } else {
    const port = mode === "api" ? 4000 : 3000;
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok || (await response.json()).app !== "aprobis-backend") throw new Error();
  }
} catch { process.exitCode = 1; }
