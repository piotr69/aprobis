import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const repoRoot = path.resolve(__dirname, "../../..");

dotenv.config({ path: path.join(repoRoot, ".env") });
dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(4000),
  // Adres nasłuchu. Za proxy tylko 127.0.0.1: inaczej klient omija proxy i sam podaje swój adres IP.
  HOST: z.string().optional(),
  FRONTEND_URL: z.string().default("http://localhost:3000"),
  FILE_STORAGE_PATH: z.string().default("./backend/storage"),
  // Dzienne pliki logów technicznych: zapas na czas, gdy baza nie przyjmuje wpisów.
  LOG_PATH: z.string().default("./backend/logs"),
  // Po tylu dniach worker kasuje logi techniczne z bazy i stare pliki. Audytu to nie dotyczy.
  LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  // Opcjonalny plik potwierdzający postęp workera (healthcheck kontenera).
  WORKER_HEARTBEAT_FILE: z.string().optional(),
  // Skaner załączników: defender (Windows), clamav (clamd po TCP) albo disabled (świadomie bez skanowania).
  // Brak wartości: defender na Windows; na innych systemach skaner nieskonfigurowany i pliki czekają.
  AV_SCANNER: z.enum(["defender", "clamav", "disabled"]).optional(),
  AV_SCANNER_PATH: z.string().optional(),
  CLAMAV_HOST: z.string().default("127.0.0.1"),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  // Czy cookie sesji działa tylko przez HTTPS. Domyślnie tak na produkcji.
  // "false" tylko dla instalacji dostępnej po HTTP w sieci wewnętrznej.
  COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  // Poczta do linków z nowym hasłem. Bez SMTP_HOST lokalnie link trafia do logu serwera.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_SECURE: z.string().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  // Liczba zaufanych proxy przed aplikacją (np. 1 dla pojedynczego nginx/IIS).
  // 0 = brak proxy. Bez tego req.ip zwraca adres proxy, więc rate limit
  // wrzuca wszystkich użytkowników do jednego kubełka.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0)
});

export const env = envSchema.parse(process.env);

export const cookieSecure = env.COOKIE_SECURE ? env.COOKIE_SECURE === "true" : env.NODE_ENV === "production";

/**
 * Katalog plików liczony od rootu repo. Względem process.cwd() API, worker i testy
 * trafiały do różnych katalogów, zależnie od tego, skąd je uruchomiono.
 */
export const fileStorageRoot = path.resolve(repoRoot, env.FILE_STORAGE_PATH);

export const logRoot = path.resolve(repoRoot, env.LOG_PATH);
