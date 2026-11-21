# Contributing to Aprobis

Thanks for your interest! Bug reports, ideas and pull requests are welcome.

## Development setup

Requirements: Node.js 22+, SQL Server (Express is enough, TCP enabled).

```bash
cp .env.example .env          # set DATABASE_URL (and TEST_DATABASE_URL for integration tests)
npm ci
npm run db:generate
npm run db:migrate:deploy
npm run db:seed -- --yes-delete-all   # demo data; DELETES everything in the database
npm run dev                   # API :4000, worker and web :3000
```

## Tests

```bash
npm test                  # unit tests, no database needed (~2 s)
npm run test:integration  # real API + database; requires TEST_DATABASE_URL pointing to a database named exactly AprobisTest
npm run build             # type-check and build backend + frontend
```

Integration tests wipe and re-seed `AprobisTest`. The test setup refuses any other database name.

## Guidelines

- The user interface, code comments and domain names are in Polish; keep new code consistent with its surroundings.
- Keep changes small and focused; add or update tests for behaviour changes.
- Backend is ESM: relative imports in TypeScript need the `.js` extension.
- Database changes: edit `prisma/schema.prisma`, create a migration and keep the hand-written SQL objects
  described in `prisma/MIGRATIONS.md`.
- Never commit `.env`, logs, uploaded files or real company data.

By contributing you agree that your contributions are licensed under the MIT License.
