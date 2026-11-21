# Migracje MSSQL

Nowa baza powstaje poleceniem `npm run db:migrate:deploy`, a dane startowe (role, typy dokumentów,
waluty) dodaje `npm run db:bootstrap`. Oba polecenia można uruchamiać wielokrotnie.

`prisma migrate dev` służy wyłącznie do lokalnej bazy deweloperskiej (`scripts/guard-migrate-dev.mjs`
blokuje je przy `NODE_ENV=production` i w CI). Produkcja używa tylko `prisma migrate deploy`.

## Elementy dopisane ręcznie

Schemat Prismy dla SQL Server nie potrafi zadeklarować kilku obiektów. Są w migracji
`00000000000000_init` i każda nowa migracja musi je zachować:

| Obiekt | Po co |
|---|---|
| `Document.row_version` jako `ROWVERSION` (Prisma generuje `VARBINARY(8)`) | wykrywanie równoczesnych zmian dokumentu |
| `CK_Document_DataJson_IsJson`, `CK_Document_MetadataJson_IsJson` | pola JSON zawsze poprawne |
| `UX_WorkflowInstance_ActiveDocument` (unikalny, `WHERE status = 'ACTIVE'`) | najwyżej jeden aktywny obieg dokumentu |
| `IX_WorkflowTask_RoleStatusDue` (z `INCLUDE`) | lista zadań wg roli |
| `User_login_key` (unikalny, `WHERE login IS NOT NULL`) | login unikalny, ale opcjonalny |
| `User_resetTokenHash_idx` (`WHERE resetTokenHash IS NOT NULL`) | wyszukiwanie linku resetu |
| wiersze `AppConfig`: `SMTP_*`, `APP_VERSION`, `EASTER_EGG_ENABLED='false'` | klucze systemowe ekranu Konfiguracja |

Z tego powodu `prisma migrate diff` bazy względem `schema.prisma` zawsze pokaże te obiekty jako różnicę.
**Nie usuwaj ich, żeby wyzerować diff.** Nową migrację sprawdzaj na pustej bazie: deploy, potem
porównanie katalogu (`sys.indexes`, `sys.check_constraints`, typy kolumn) z bazą przed zmianą.
