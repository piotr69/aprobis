# Aprobis

[English](README.md) · **Polski**

Aprobis to otwarty (licencja MIT) program do elektronicznego obiegu i akceptacji dokumentów w firmie:
pracownik tworzy dokument, system sam ustala, kto ma go zaakceptować, a każda decyzja zostaje w historii.

- Typy dokumentów z własnymi formularzami (faktury, umowy, wnioski urlopowe, zamówienia i inne).
- Ścieżki akceptacji z reguł: kwota, dział, kategoria; limity akceptacji i przełożeni.
- Etapy decyzyjne i „do wiadomości”, zwrot do poprawy, zastępstwa, przekazanie zadania.
- Terminy i przypomnienia, powiadomienia mailowe o nowych zadaniach.
- Pełny audyt decyzji, skanowanie załączników antywirusem, raporty.

Interfejs jest po polsku. Wersja: 0.0.1 (wczesny etap rozwoju).

## Wymagania

Node.js 22+, Microsoft SQL Server (wystarczy darmowy SQL Server Express z włączonym TCP).
Skanowanie załączników (`AV_SCANNER`): Windows Defender, ClamAV (clamd po TCP) albo świadomie wyłączone — szczegóły w `.env.example`.
Plik przesłany przy wyłączonym skanowaniu jest oznaczony „Nie skanowano”; po włączeniu skanera wraca do kolejki skanu.

## Uruchomienie deweloperskie

1. Skopiuj `.env.example` do `.env` i ustaw `DATABASE_URL`.
2. Utwórz pustą bazę, np. `CREATE DATABASE Aprobis;`.
3. Zainstaluj i przygotuj bazę:

   ```bash
   npm ci
   npm run db:generate
   npm run db:migrate:deploy
   npm run db:seed -- --yes-delete-all   # dane przykładowe; KASUJE wszystko, co jest w bazie
   ```

4. Uruchom całość jednym poleceniem:

   ```bash
   npm run dev
   ```

Aplikacja: <http://localhost:3000>. API: <http://localhost:4000/api>.

`npm run dev` uruchamia API, frontend i **worker**. Bez workera załączniki zostają w stanie „Skanowanie…”,
a przypomnienia o terminach nie wychodzą.

Nowa instalacja bez danych przykładowych: `npm run db:migrate:deploy`, `npm run db:bootstrap` (role, typy
dokumentów, waluty) i `npm run db:create-admin` (pierwsze konto administratora — program zapyta o dane, hasło bez
wyświetlania; w automatyzacji zmienne `ADMIN_EMAIL`, `ADMIN_LOGIN`, `ADMIN_FIRST_NAME`, `ADMIN_LAST_NAME` oraz
`ADMIN_PASSWORD` albo `ADMIN_PASSWORD_FILE`). Ponowne uruchomienie niczego nie zmienia. Instalacja produkcyjna na Windows Server: [docs/instalacja-windows.md](docs/instalacja-windows.md) (instalator `deployment/Install-Aprobis.ps1`).

## Docker

Compose uruchamia SQL Server Express, ClamAV, inicjalizację bazy, API, worker i frontend. Wymaga kontenerów Linux
na x86-64 i co najmniej 8 GiB RAM dla Dockera. Przygotuj `.env.docker` z szablonu, wygeneruj sekrety przez
`node scripts/create-docker-secrets.mjs`, wpisz dane administratora i po przeczytaniu licencji Microsoft ustaw
`ACCEPT_EULA=Y`. SQL Server Express ma własną licencję, odrębną od MIT aplikacji.

```powershell
docker compose --env-file .env.docker build
docker compose --env-file .env.docker up -d
```

Lokalny adres: <http://localhost:3000>. Na zewnątrz publikowany jest tylko frontend na loopback; produkcja wymaga
proxy HTTPS. [Pełna instrukcja: sekrety, HTTPS, dane, aktualizacje i test odbioru](docs/instalacja-docker.md).

### Jeśli baza się nie łączy

- **Port.** Sprawdź w SQL Server Configuration Manager, na jakim porcie działa TCP. Port dynamiczny może się zmienić po restarcie, lepiej ustawić stały.
- **Adres.** Gdy SQL Server nasłuchuje tylko na IPv4, użyj `127.0.0.1` zamiast `localhost`.
- **Logowanie.** Na Windows najprościej użyć konta systemowego: `integratedSecurity=true` (przykład w `.env.example`).

## Konta przykładowe

Tworzy je `npm run db:seed`. Hasła są publicznie znane — tylko do środowiska deweloperskiego.

| Login | Rola | Hasło |
| --- | --- | --- |
| `admin` | Administrator systemu | `Admin#2026` |
| `marek.prezes` | Zarząd | `Marek#2026` |
| `ewa.zarzad` | Zarząd | `Ewa#2026` |
| `piotr.dyrektor` | Dyrektor | `Piotr#2026` |
| `anna.kierownik` | Kierownik działu | `Anna#2026` |
| `jan.pracownik` | Pracownik | `Jan#2026` |
| `maria.ksiegowosc` | Księgowość | `Maria#2026` |
| `tomasz.prawny` | Dział prawny | `Prawny#2026` |
| `olga.zakupy` | Zakupy | `Zakupy#2026` |
| `adam.it` | IT | `IT#2026!!` |
| `karolina.hr` | Kadry | `HR#2026!!` |
| `sekretariat` | Sekretariat | `Sekretariat#2026` |
| `audytor` | Audytor | `Audytor#2026` |

## Logowanie i hasła

- Logowanie loginem albo e-mailem.
- Po 3 błędnych próbach konto blokuje się na 15 minut. Blokada wygasa sama, a administrator może ją zdjąć wcześniej.
- „Nie pamiętam hasła” wysyła link ważny 1 godzinę i działający raz. Ustawienie hasła zdejmuje blokadę i wylogowuje wszystkie sesje.
- Hasło ma od 8 do 128 znaków.

Link wysyłany jest przez SMTP (`SMTP_HOST` i pokrewne w `.env` albo w Administracja → Konfiguracja).
Bez SMTP lokalnie link trafia do logu serwera.

## Polecenia

```bash
npm run dev               # API, worker i frontend
npm test                  # testy jednostkowe, bez bazy
npm run test:integration  # scenariusze na bazie AprobisTest (TEST_DATABASE_URL); czyści tylko ją
npm run build             # kompilacja backendu i frontendu
```

## Dokumentacja

- [Instrukcja obsługi](docs/instrukcja-obslugi.md)
- [Obieg i role](docs/workflow.md)
- [Scenariusze](docs/scenariusze-testowe.md)
- [API](docs/api.md)
- [Model danych](docs/model-danych.md)
- [Migracje](prisma/MIGRATIONS.md)
- [Dalsza rozbudowa](docs/dalsza-rozbudowa.md)
- [Bezpieczeństwo](SECURITY.md) · [Współpraca](CONTRIBUTING.md) · [Licencje zależności](THIRD_PARTY_NOTICES.md)

## Licencja

[MIT](LICENSE)
