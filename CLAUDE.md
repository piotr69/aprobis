# Aprobis

Aprobis — open source'owy obieg i akceptacja dokumentów w firmie (licencja MIT). npm workspaces: `backend` (Express 5 + Prisma),
`frontend` (Next.js 15 App Router). Baza: MSSQL. Kod i komentarze po polsku.

## Komendy

```bash
npm run dev              # API :4000/api, worker i frontend :3000 jednym poleceniem
npm test                 # vitest w backendzie, ~2s, czyste unity — NIE wymaga bazy
npm run test:integration # prawdziwe API + baza AprobisTest z TEST_DATABASE_URL; czyści wyłącznie ją
npm run build            # tsc (backend) + next build (frontend); nie uruchamiaj przy działającym next dev
npm run db:generate      # po każdej zmianie prisma/schema.prisma
npm run db:migrate:dev   # lokalnie; guard blokuje w NODE_ENV=production i CI
npm run db:migrate:deploy# nowe środowiska i produkcja
npm run db:seed -- --yes-delete-all # dane przykładowe (hasła w README); KASUJE całą zawartość bazy
npm run db:bootstrap     # role, typy dokumentów i waluty dla nowej instalacji; niczego nie kasuje
npm run db:create-admin  # pierwszy SYSTEM_ADMIN (CREATED / ALREADY_INITIALIZED, exit 0); nigdy nie resetuje hasła
```

Worker outboxa to **osobny proces** (`npm run dev` go uruchamia). Bez niego pliki zostają
w `scanStatus: PENDING`, a przypomnienia o terminach nie wychodzą.

## Architektura

```text
prisma/schema.prisma        źródło prawdy dla bazy — leży w roocie, NIE w backend/
backend/src/app.ts          montowanie routerów, helmet, CORS, origin check, correlation id
backend/src/modules/<x>/    routery + logika domenowa (documents, workflow, rules, reports, audit…)
backend/src/shared/         roles.ts (co może rola), access.ts (kto widzi dokument i kto ma zadanie),
                            taskAccess.ts, audit.ts, transactions.ts, http.ts, session.ts, password.ts
backend/src/shared/domain.ts  enumy jako `as const` (SystemRole, DocumentStatus, …) — MSSQL trzyma je jako NVarChar
backend/src/worker.ts       pętla outboxa (`file.scan.requested`) i przypomnienia o terminach
backend/tests/integration/  scenariusze przez prawdziwe API na bazie AprobisTest
frontend/app/(app)/         ekrany; każdy ma własny adres URL
frontend/lib/api.ts         jedyny punkt wyjścia do API; `credentials: "include"` + redirect na /login przy 401
frontend/lib/queries.ts     react-query hooks
frontend/lib/format.ts      etykiety statusów, daty, kwoty
```

## Gotchas

- **Backend to ESM** (`"type": "module"`): importy w TS muszą mieć rozszerzenie `.js`
  (`import { prisma } from "../shared/prisma.js"`), także w testach.
- **Autoryzacja to sesje w bazie.** Cookie `aprobis_session` (httpOnly, `path=/api`,
  TTL 8h), w bazie tylko SHA-256 hash tokenu.
- **Logowanie i reset hasła** (`shared/loginPolicy.ts`): login lub e-mail, blokada 3 próby/15 min, link resetu 1 h, jednorazowy.
- **Limit akceptacji** (`shared/approvalLimit.ts`) działa w trzech miejscach: wyznaczanie osoby, lista zadań i decyzja. Zmieniaj razem.
- **Rola to nie prawo do decyzji.** Decyzję daje przydzielone zadanie. Rola określa widoczność i moduły
  (`shared/roles.ts`). Tabele Permission/RolePermission i DocumentAccessPolicy nie uczestniczą w autoryzacji.
- **Jedna definicja dostępu.** Lista i szczegóły używają `documentVisibilityWhere`, a listy zadań i silnik
  mają tę samą regułę wykonawcy. Zmiana w jednym miejscu wymaga zmiany w drugim (`resolveActor`).
- **Etap „do wiadomości” (stageKind INFO) nie tworzy zadań.** Obieg przesuwa wyłącznie `advanceStages` (przy złożeniu
  i po decyzji): realizuje INFO przez `WorkflowStageRecipient` (wgląd bez notatek wewnętrznych, cofany przy zwrocie
  i anulowaniu) i otwiera kolejne decyzje. To osobna gałąź `documentVisibilityWhere`; `assertDocumentAccess` zwraca `infoOnly`.
- **Korekta nie jest zadaniem.** Zwrot ustawia NEEDS_CORRECTION, autor składa ponownie, obieg startuje od początku.
- **SQL Server Express** ma często port dynamiczny i `sa` bez znanego hasła: lokalnie `integratedSecurity=true`.
- **Ręczne komendy Prisma potrzebują `--schema prisma/schema.prisma`** (skrypty npm już to mają).
- **`.env` czytany jest z roota repo**, nie z `backend/` — `config/env.ts` resolwuje `../../../.env`.
- **MSSQL wymaga jawnych typów** (`@db.NVarChar(32)`, `@db.Decimal(18,2)`) i `onDelete: NoAction`
  na relacjach — kaskady tworzą cykle, których MSSQL nie przyjmie.
- **SYSTEM_ADMIN celowo NIE omija wszystkiego**: nie decyduje w zadaniach (`canDecideTasks`), nie edytuje
  cudzej treści, nie przepisze zadania na siebie — rozdział obowiązków, są na to testy. Nie „naprawiaj" tego.
- **Zastępca nie decyduje o dokumencie zastępowanego** (B01 w testach): autor nie może nadać tego prawa komuś innemu.
- **Skaner AV** (`modules/files/antivirus.ts`, `clamav.ts`, `fileAvailability.ts`): `AV_SCANNER=defender|clamav|disabled`. Statusy pliku
  `PENDING | CLEAN | REJECTED | NOT_SCANNED`; `NOT_SCANNED` (tylko disabled) nigdy nie znaczy „bezpieczny”. Czy plik wolno wydać/liczyć,
  rozstrzyga wyłącznie `isFileUsable`/`usableScanStatuses` — nie porównuj `scanStatus === "CLEAN"` ręcznie. Błąd skanera = UNAVAILABLE
  → PENDING z ponowieniem. Worker przy starcie (`requeueNotScannedFiles`) kolejkuje NOT_SCANNED po włączeniu skanera.
- **Hasła**: wyłącznie argon2id (`shared/password.ts`); skrót w innym formacie nie przechodzi weryfikacji.
- **Docker**: `docs/instalacja-docker.md`, zawsze `docker compose --env-file .env.docker ...`. Sekrety w ignorowanym
  `.secrets/`, nigdy w kontekście obrazu. `migrate` ma konto SQL administratora, API/worker ograniczone konto,
  web bez sekretów. API w prywatnej sieci na `0.0.0.0`; tylko web publikuje port hosta na loopback.
  `WORKER_HEARTBEAT_FILE` opcjonalnie zapisuje postęp pętli workera (healthcheck 5 min).
- **Migracje**: ręczne obiekty SQL w `00000000000000_init` (ROWVERSION, CHECK ISJSON, indeksy filtrowane) — `prisma/MIGRATIONS.md`.
- **Produkcja (Windows)**: `deployment/Install-Aprobis.ps1` (`-Mode Check|Install|Upgrade|Uninstall`), opis w `docs/instalacja-windows.md`.
  Plik .ps1 tylko ASCII (PS 5.1 czyta bez BOM w ANSI). `sqlcmd` zawsze z `-I` (indeksy filtrowane wymagają QUOTED_IDENTIFIER ON). Adres API jest wbudowywany przy `next build` (`NEXT_PUBLIC_API_URL`, `API_INTERNAL_URL`), a po HTTP działa tylko z `COOKIE_SECURE="false"`.
- **Mail o zadaniu** (`modules/notifications/task-mail.ts`): `notifyTaskOpened` dokłada komunikat outboxa w tej samej transakcji, a worker przed wysyłką sprawdza wersję zadania i aktualnych odbiorców. W treści nie ma tytułu ani pól dokumentu.
- **Logi techniczne** (`shared/logger.ts`) idą do tabeli `SystemLog` i dziennych plików w `LOG_PATH` tylko po
  `configureLogger` — wołają go wyłącznie `server.ts` i `worker.ts`; testy i skrypty piszą na konsolę.
  Worker kasuje je po `LOG_RETENTION_DAYS`. Ślad działań ludzi to osobny audyt (`writeAuditInTransaction`), na stałe.
  Oba ekrany widzi tylko SYSTEM_ADMIN (`viewAudit`, `viewSystemLogs`).
- **Konfiguracja** (`shared/config.ts`, tabela AppConfig, ekran /admin/config, capability `manageConfig`): cache 30 s
  osobno w API i workerze; błąd bazy nie jest cache'owany. Poczta (`getSmtpSettings`) bierze cały zestaw z Konfiguracji,
  gdy jest tam `SMTP_HOST`, inaczej z `.env`. Sekrety (PASSWORD/SECRET w nazwie) wychodzą z API i do audytu tylko jako maska.
- **Wersja**: `APP_VERSION` ustawia API przy starcie z głównego `package.json` (`syncAppVersion`); „Nowa wersja” przez
  2 dni od zmiany numeru, nie od reinstalacji. Commit i datę instalacji daje `release.json` z instalatora.
- **Router reguł wisi pod dwoma ścieżkami**: `/api/rules` i `/api/approval-rules` (kompatybilność).
- Błędy zwracaj przez `throw new AppError(status, msg)` w `asyncHandler` — `errorHandler` mapuje
  też `ZodError` na 400. Nie wołaj `res.status(...)` ręcznie dla błędów.
- Zmiany stanu dokumentu i zadań idą przez `workflow.engine.ts` w transakcji razem z audytem
  (`writeAuditInTransaction`) — nie aktualizuj statusów bezpośrednio przez `prisma.document.update`.
- Nie ma lintu w roocie; `next lint` istnieje tylko we frontendzie.

