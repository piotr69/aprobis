# Model Danych

Model znajduje się w `prisma/schema.prisma` i jest przygotowany pod MSSQL.

## Główne tabele

- `users`: użytkownicy, role, działy, stanowiska, przełożeni, limity akceptacji, aktywność.
- `departments`: działy, hierarchia działów, kierownicy.
- `positions`: stanowiska i poziomy decyzyjne.
- `organization_units`: jednostki organizacyjne, lokalizacje i drzewo organizacji.
- `user_substitutions`: zastępstwa użytkowników z okresem obowiązywania.
- `document_types`: słownik typów dokumentów i kategorii.
- `documents`: rejestr dokumentów, metadane, status, kwoty, kontrahent, koszt/projekt.
- `document_files`: załączniki i wersje plików.
- `workflow_definitions`: wersjonowane definicje workflow.
- `workflow_steps`: kroki definicji workflow, role, terminy, warunki.
- `workflow_instances`: uruchomione obiegi dokumentów.
- `workflow_tasks`: zadania do wykonania przez użytkowników lub role.
- `workflow_actions`: decyzje, komentarze i akcje w obiegu.
- `approval_rules`: reguły warunkowe zapisane jako JSON w polach tekstowych zgodnych z MSSQL.
- `comments`: komentarze dokumentów i zadań.
- `notifications`: powiadomienia w aplikacji.
- `audit_logs`: pełny audyt operacji.
- `dictionaries`: słowniki techniczne.
- `cost_centers`: centra kosztów.
- `projects`: projekty i powiązanie z centrum kosztów.

## Ważne decyzje projektowe

- Warunki i akcje reguł są zapisane jako tekst JSON, bo MSSQL nie ma natywnego typu JSON obsługiwanego tak jak PostgreSQL.
- Dokument ma status biznesowy, a workflow osobno przechowuje instancję i zadania.
- Zadania mogą być przypisane do konkretnego użytkownika albo roli.
- Zastępstwa są sprawdzane w chwili działania, więc obejmują też zadania otwarte wcześniej i wygasają z terminem.
- Nieużywane pola i tabele (zachowane dla zgodności schematu, bez wpływu na działanie): `Permission`, `RolePermission`, `DocumentAccessPolicy`, `User.permissionsJson`, `User.decisionLevel`, `WorkflowStep.requiredPermission`, `DocumentTransition`, `DocumentStatusDefinition`.
- Audyt zapisuje stan przed i po zmianie jako JSON tekstowy.

