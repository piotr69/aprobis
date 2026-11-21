import { readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { ZodError } from "zod";
import { AdminBootstrapError, bootstrapAdmin, type AdminInput } from "../backend/src/shared/bootstrapAdmin.js";

/**
 * Pierwszy administrator: `npm run db:create-admin`.
 * Dane ze zmiennych ADMIN_EMAIL, ADMIN_LOGIN, ADMIN_FIRST_NAME, ADMIN_LAST_NAME oraz ADMIN_PASSWORD
 * albo ADMIN_PASSWORD_FILE (plik z hasłem, np. sekret Dockera). Brakujące pola program zada w konsoli,
 * hasło bez wyświetlania. Hasła nie przyjmuje jako argumentu wiersza poleceń i nigdzie go nie wypisuje.
 * Gdy administrator już istnieje, kończy się sukcesem bez żadnych zmian.
 */
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function askHidden(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          cleanup();
          reject(new Error("Przerwano"));
          return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });
}

function passwordFromEnv(): string | undefined {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const file = process.env.ADMIN_PASSWORD_FILE;
  // Windows PowerShell 5.1 zapisuje UTF-8 ze znacznikiem BOM — nie może stać się częścią hasła.
  if (file) return readFileSync(file, "utf8").replace(/^﻿/, "").replace(/\r?\n$/, "");
  return undefined;
}

async function field(envName: string, label: string, optional = false): Promise<string | undefined> {
  const value = process.env[envName]?.trim();
  if (value) return value;
  if (!interactive) {
    if (optional) return undefined;
    throw new Error(`Brak zmiennej ${envName}`);
  }
  const answer = await ask(`${label}${optional ? " (Enter = bez loginu)" : ""}: `);
  return answer || undefined;
}

async function readInput(): Promise<AdminInput> {
  const email = await field("ADMIN_EMAIL", "E-mail administratora");
  const login = await field("ADMIN_LOGIN", "Login", true);
  const firstName = await field("ADMIN_FIRST_NAME", "Imię");
  const lastName = await field("ADMIN_LAST_NAME", "Nazwisko");
  let password = passwordFromEnv();
  if (!password) {
    if (!interactive) throw new Error("Brak ADMIN_PASSWORD albo ADMIN_PASSWORD_FILE");
    password = await askHidden("Hasło (8–128 znaków): ");
    const repeated = await askHidden("Powtórz hasło: ");
    if (password !== repeated) throw new Error("Hasła się różnią");
  }
  return { email: email ?? "", login, firstName: firstName ?? "", lastName: lastName ?? "", password };
}

async function main() {
  const prisma = new PrismaClient();
  try {
    // Najpierw sprawdzenie bez pytania o dane: przy ponownym uruchomieniu niczego nie trzeba podawać.
    const existing = await prisma.user.findFirst({ where: { role: "SYSTEM_ADMIN", isActive: true }, select: { id: true } });
    if (existing) {
      console.log("ALREADY_INITIALIZED: aktywny administrator już istnieje, nic nie zmieniono.");
      return;
    }
    // Szybkie sprawdzenia przed pytaniem o dane; autorytatywne są te w transakcji bootstrapAdmin.
    if (!(await prisma.role.findFirst({ where: { code: "SYSTEM_ADMIN", isActive: true }, select: { id: true } }))) {
      throw new AdminBootstrapError("Brak roli SYSTEM_ADMIN. Najpierw uruchom: npm run db:bootstrap");
    }
    if ((await prisma.user.count()) > 0) {
      throw new AdminBootstrapError("W bazie są konta, ale żadne nie jest aktywnym administratorem. Pierwszego administratora nie tworzę automatycznie.");
    }
    const outcome = await bootstrapAdmin(prisma, await readInput());
    console.log(outcome.result === "CREATED"
      ? "CREATED: utworzono pierwsze konto administratora."
      : "ALREADY_INITIALIZED: aktywny administrator już istnieje, nic nie zmieniono.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  if (error instanceof ZodError) console.error(`Błędne dane: ${error.issues.map((issue) => issue.message).join("; ")}`);
  else if (error instanceof AdminBootstrapError) console.error(error.message);
  else console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
