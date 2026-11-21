import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync, existsSync } from "node:fs";

const directory = new URL("../.secrets/", import.meta.url);
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
for (const name of ["sql-sa-password", "sql-app-password", "admin-password"]) {
  const file = new URL(name, directory);
  if (existsSync(file)) {
    console.log(`${name}: kept existing secret`);
    continue;
  }
  // Deliberately don't print passwords; creation is exclusive and never replaces a secret.
  // Compose file secrets are bind mounts: SQL's UID 10001 and Node's UID 1000 both need read access.
  // The containing directory is 0700, so other host users still cannot reach the files.
  writeFileSync(file, `Aa0_${randomBytes(36).toString("base64url")}\n`, { flag: "wx", mode: 0o644 });
  chmodSync(file, 0o644);
  console.log(`${name}: created`);
}
