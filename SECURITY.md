# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Once this repository is public, report vulnerabilities through GitHub's private vulnerability reporting
(**Security → Report a vulnerability**). Until then, contact the repository owner directly.

Include the affected version, steps to reproduce and the impact you observed. We will acknowledge the report,
agree on a fix and a disclosure date with you, and credit you unless you prefer otherwise.

## Supported versions

Aprobis is in early development (0.x). Only the latest release receives security fixes.

## Deployment checklist

- Serve the application over **HTTPS**. Leave `COOKIE_SECURE` unset (secure cookies are the production default);
  use `COOKIE_SECURE="false"` only for a local demo over plain HTTP.
- Expose only the web front end. The API must listen on `127.0.0.1` (or a private container network) behind the
  reverse proxy, and `TRUST_PROXY_HOPS` must match the number of proxies in front of it.
- Use a dedicated SQL login with rights to the Aprobis database only — never `sa`.
- Protect `.env` with file-system permissions (only the service account and administrators).
- **Secrets in the database:** SMTP settings entered on the *Administration → Configuration* screen, including
  `SMTP_PASSWORD`, are stored in the `AppConfig` table in plain text (the API only returns them masked).
  Treat database backups as confidential, or keep SMTP credentials in `.env` instead.
- Keep antivirus scanning of attachments enabled in production (`AV_SCANNER=defender` or `clamav`). `/api/health`
  reports the active mode; `disabled` or `unconfigured` there means attachments are not being checked.
- Never run `npm run db:seed` against a production database: it deletes all data and creates demo accounts
  with publicly known passwords.
