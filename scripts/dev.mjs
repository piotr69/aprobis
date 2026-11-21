// `npm run dev`: uruchamia API, worker i frontend jednym poleceniem.
// Worker jest wymagany: bez niego załączniki zostają na zawsze w stanie „skanowanie”.
import { spawn } from "node:child_process";

const processes = [
  ["api", "npm run dev --workspace backend"],
  ["worker", "npm run dev:worker --workspace backend"],
  ["web", "npm run dev --workspace frontend"]
];

const children = processes.map(([name, command]) => {
  const child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const prefix = (chunk) => String(chunk).split(/\r?\n/).filter(Boolean).forEach((line) => console.log(`[${name}] ${line}`));
  child.stdout.on("data", prefix);
  child.stderr.on("data", prefix);
  child.on("exit", (code) => {
    console.log(`[${name}] zakończono (kod ${code})`);
    stop();
  });
  return child;
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      child.kill();
    }
  }
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
