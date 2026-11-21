import os from "node:os";
import path from "node:path";
import { testDatabaseUrl } from "./test-database.js";

// Musi zadziałać przed importem Prisma: dotenv nie nadpisuje istniejących zmiennych.
process.env.DATABASE_URL = testDatabaseUrl();
process.env.NODE_ENV = "test";
process.env.FILE_STORAGE_PATH = path.join(os.tmpdir(), "aprobis-test-storage");
process.env.FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:3000";
