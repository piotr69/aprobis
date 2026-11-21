if (process.env.NODE_ENV === "production" || process.env.CI === "true") {
  console.error("prisma migrate dev is disabled in production and CI; use npm run db:migrate:deploy");
  process.exit(1);
}
