# Aprobis

**English** · [Polski](README.pl.md)

Aprobis is an open-source (MIT) document workflow and approval system for companies: an employee creates
a document, the system works out who has to approve it, and every decision is kept in the audit trail.

- Document types with their own forms (invoices, contracts, leave requests, purchase orders and more).
- Rule-based approval paths: amount, department, category; approval limits and line managers.
- Decision stages and "for information" stages, return for correction, deputies, task hand-over.
- Deadlines and reminders, e-mail notifications about new tasks.
- Full decision audit, antivirus scanning of attachments, reports.

The user interface is in **Polish**. Version: 0.0.1 (early development).

## Requirements

Node.js 22+, Microsoft SQL Server (the free SQL Server Express with TCP enabled is enough).
Attachment scanning (`AV_SCANNER`): Windows Defender, ClamAV (clamd over TCP) or deliberately disabled — see `.env.example`.
Files uploaded while scanning is disabled are marked "not scanned" and are queued for scanning once a scanner is enabled.

## Development quick start

1. Copy `.env.example` to `.env` and set `DATABASE_URL`.
2. Create an empty database, e.g. `CREATE DATABASE Aprobis;`.
3. Install and prepare the database:

   ```bash
   npm ci
   npm run db:generate
   npm run db:migrate:deploy
   npm run db:seed -- --yes-delete-all   # demo data; DELETES everything in the database
   ```

4. Start everything with one command:

   ```bash
   npm run dev
   ```

App: <http://localhost:3000>. API: <http://localhost:4000/api>.

`npm run dev` starts the API, the front end and the **worker**. Without the worker, attachments stay in the
"Scanning…" state and deadline reminders are not sent.

For a new installation without demo data run `npm run db:migrate:deploy`, `npm run db:bootstrap` (roles,
document types, currencies) and `npm run db:create-admin` (first administrator account; it prompts for the details and
the password without echo, or reads `ADMIN_EMAIL`, `ADMIN_LOGIN`, `ADMIN_FIRST_NAME`, `ADMIN_LAST_NAME` and
`ADMIN_PASSWORD` / `ADMIN_PASSWORD_FILE`). Running it again changes nothing. Production installation on Windows Server: [docs/instalacja-windows.md](docs/instalacja-windows.md) (installer `deployment/Install-Aprobis.ps1`, in Polish).

## Docker

Docker Compose runs SQL Server Express, ClamAV, a one-shot database initializer, API, worker and web front end.
Use Linux containers on x86-64 with at least 8 GiB RAM available. Copy `.env.docker.example` to `.env.docker`,
run `node scripts/create-docker-secrets.mjs`, set your administrator details and accept the Microsoft SQL Server
license (`ACCEPT_EULA=Y`) after reading it. Then run:

```bash
docker compose --env-file .env.docker build
docker compose --env-file .env.docker up -d
```

The local demo is at <http://localhost:3000>. Only the web port is published, on loopback. Production access needs
an HTTPS reverse proxy and secure cookies. SQL Server Express has its own Microsoft license; Aprobis's MIT license
does not cover it. See [Docker setup, secrets, HTTPS, backup and upgrades](docs/instalacja-docker.md) (in Polish).

Demo accounts created by the seed (e.g. `admin` / `Admin#2026`) are listed in [README.pl.md](README.pl.md#konta-przykładowe).
Their passwords are public — development only.

## Commands

```bash
npm run dev               # API, worker and front end
npm test                  # unit tests, no database needed
npm run test:integration  # scenarios on the AprobisTest database (TEST_DATABASE_URL); wipes only that database
npm run build             # build backend and front end
```

## Documentation (Polish)

- [User guide](docs/instrukcja-obslugi.md)
- [Workflow and roles](docs/workflow.md)
- [API](docs/api.md) · [Data model](docs/model-danych.md) · [Migrations](prisma/MIGRATIONS.md)
- [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)

## License

[MIT](LICENSE)
