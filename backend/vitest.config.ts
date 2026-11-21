import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Testy integracyjne wymagają bazy: `npm run test:integration`.
    exclude: ["tests/integration/**", "**/node_modules/**"]
  }
});
