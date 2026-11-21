# API

Adres bazowy: `http://localhost:4000/api`. Autoryzacja: sesja w cookie `aprobis_session` (`POST /auth/login`). Błędy: `{ message, details?: { issues: [{ field, message }] } }`.

## Konto

- `POST /auth/login`, `POST /auth/logout`
- `GET /auth/me`: profil z rolą, `capabilities` i aktywnymi zastępstwami
- `POST /auth/change-password`: kończy wszystkie sesje
- `POST /auth/password-reset`: `{ identifier }`, odpowiedź zawsze `{ ok: true }`
- `POST /auth/password-reset/confirm`: `{ token, password }`

Błędy logowania mają `details.code`: `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED` albo `ACCOUNT_INACTIVE`.

## Moja praca

- `GET /workflow/tasks/my`: otwarte zadania, które mogę wykonać
- `GET /workflow/actions/my?limit&cursor`: co zrobiłem osobiście
- `GET /documents?scope=involved&status=...`: dokumenty z moim udziałem

## Dokumenty

- `GET /documents?scope&status&typeId&search&limit&cursor`: `scope` to `created-by-me`, `assigned-to-me` albo `involved`; `status` może zawierać wiele wartości po przecinku
- `POST /documents`, `PATCH /documents/:id` (`expectedVersion`)
- `GET /documents/:id`: szczegóły z `formFields`, `actionsAllowed` i `myTask`
- `GET /documents/:id/workflow-preview`: ścieżka, jaką dokument przeszedłby teraz
- `POST /documents/:id/submit`, `/cancel`, `/archive`
- `POST /documents/:id/comments`: `visibility` to `AUTHOR` albo `INTERNAL`
- `GET|POST /documents/:id/files`, `GET /documents/:id/files/:fileId[/download]`, `DELETE /documents/:id/files/:fileId`

## Zadania

- `GET /workflow/tasks/:id`
- `POST /workflow/tasks/:id/decision`: `{ decision: "APPROVE" | "RETURN" | "REJECT", comment, expectedVersion }`; `comment` wymagany przy zwrocie i odrzuceniu
- `POST /workflow/tasks/:id/delegate`: `{ delegateToUserId, expectedVersion }`
- `POST /workflow/tasks/:id/reassign`: administrator, `{ assignToUserId, comment, expectedVersion }`

## Organizacja

- `GET /users`, `GET /users/roles`, `POST /users`, `PATCH /users/:id`
- `GET|POST /organization/departments`, `PATCH /organization/departments/:id`
- `GET /organization/positions`
- `GET|POST /organization/substitutions`, `DELETE /organization/substitutions/:id`

## Konfiguracja

- `GET|POST /document-types`, `PATCH /document-types/:id`, `POST /document-types/:id/versions/:versionId/publish`
- `GET|POST /rules`, `PATCH /rules/:id` (także pod `/approval-rules`)
- `GET|POST /rules/workflow-definitions`, `POST /rules/workflow-definitions/:id/version`, `/publish`, `/deactivate`

## Raporty i powiadomienia

- `GET /reports/documents`, `/reports/overdue`, `/reports/cycle-times`
- `GET /audit-logs?take&search`
- `GET /notifications`, `PATCH /notifications/:id/read`, `PATCH /notifications/read-all`
