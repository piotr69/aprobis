import { defineConfig } from "vitest/config";

// Testy integracyjne: prawdziwe API + osobna baza. `npm run test:integration` w roocie.
// Baza testowa jest czyszczona seedem — setup odmawia pracy na bazie spoza listy.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    setupFiles: ["tests/integration/env-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000
  }
});
