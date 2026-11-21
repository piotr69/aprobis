# Aprobis — Docker Compose

Jeden obraz aplikacji uruchamia trzy procesy: API, worker oraz frontend. Osobny kontener `migrate`
tworzy bazę i ograniczone konto SQL, wykonuje migracje, uzupełnia słowniki oraz tworzy pierwszego
administratora. Nie uruchamia seeda, nie tworzy kont demonstracyjnych i nie resetuje istniejących haseł.

## Wymagania

- Linux x86-64 albo Docker Desktop z silnikiem Linux/WSL2 na Windows x86-64; Docker Compose v2 lub nowszy.
  Kontener SQL Server nie ma wspieranego profilu ARM; emulacja nie jest profilem odbioru tej instalacji.
- Przydziel Dockerowi co najmniej 8 GiB RAM (zalecane 10–12 GiB na czas budowania), kilka rdzeni oraz
  miejsce na obrazy, bazę i załączniki. Sam ClamAV potrzebuje minimum 3 GiB, zalecane 4 GiB podczas
  przeładowania sygnatur. Pierwszy start pobiera sygnatury i może potrwać kilkanaście minut.
- Dostęp do rejestrów obrazów, npm i serwerów aktualizacji ClamAV. Istniejące sygnatury zostają w wolumenie.
- Node.js 22+ na hoście do jednorazowego wygenerowania sekretów (ewentualnie własny generator haseł zgodny
  z opisanym niżej formatem). Sama działająca aplikacja korzysta z Node w obrazie.

Obrazy Node, SQL Server i ClamAV mają przypięte wersje **i digesty** w Dockerfile/Compose. Przed aktualizacją
sprawdź wydania producentów, zmień digest i powtórz testy. `apt-get` pobiera bieżące poprawki systemowe przy
budowaniu. Nie kopiujemy `node_modules`, `.next`, `.env`, sekretów ani roboczych notatek z hosta do obrazu:
`.dockerignore` jest allowlistą. Obraz zawiera Prisma CLI i `tsx`, potrzebne do inicjalizacji.

## Licencje

Aprobis jest na licencji MIT. SQL Server jest **odrębnym, własnościowym produktem Microsoft**;
Compose wybiera bezpłatną edycję **Express**. Jej ograniczenia i uprawnienia wynikają z licencji Microsoft,
nie z licencji Aprobis. Przeczytaj [warunki SQL Server](https://go.microsoft.com/fwlink/?LinkId=746388)
przed ustawieniem `ACCEPT_EULA=Y`. ClamAV jest oddzielnym programem GPL-2.0; używamy oficjalnego obrazu
i protokołu TCP. Pozostałe informacje: [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## Pierwszy start — lokalnie

W katalogu projektu:

```powershell
Copy-Item .env.docker.example .env.docker
node scripts/create-docker-secrets.mjs
```

Na Linux zamiast `Copy-Item` użyj `cp`. Generator tworzy trzy różne losowe hasła w `.secrets/`
i zachowuje już istniejące pliki. Niczego nie wypisuje poza nazwami plików. Hasła SQL muszą mieć
32–128 znaków ze zbioru `A-Z`, `a-z`, `0-9`, `_`, `-`, z dużą i małą literą oraz cyfrą. Ten ograniczony
alfabet zapobiega niejednoznacznemu kodowaniu poświadczeń w adresie połączenia SQL.

**Zabezpiecz `.secrets/` i `.env.docker` przed innymi użytkownikami hosta.** Na Linux generator tworzy
katalog z trybem 0700, a pliki z 0644: plik sekretu montowany przez Compose musi być czytelny zarówno
dla UID 1000 aplikacji, jak i UID 10001 SQL Server. Katalog 0700 chroni je przed innymi użytkownikami hosta.
Generator ustawia te prawa jawnie, również przy restrykcyjnej masce `umask`. Jeśli tworzysz pliki ręcznie,
zapisz je jako UTF-8 bez BOM i z końcem linii LF; kontener SQL i skrypt inicjalizacji tolerują także
UTF-8 BOM oraz CRLF. Na Windows ogranicz ACL
katalogu do swojego konta i administratorów. Compose secrets z plików to montowania, nie szyfrowany sejf;
administrator hosta/Dockera ma do nich dostęp. Nie wysyłaj tych plików do repo ani w paczce instalacyjnej.

W `.env.docker` ustaw:

- `ACCEPT_EULA=Y` po zapoznaniu się z licencją Microsoft;
- `ADMIN_EMAIL`, `ADMIN_FIRST_NAME`, `ADMIN_LAST_NAME`, opcjonalnie `ADMIN_LOGIN`;
- dla lokalnego testu pozostaw `PUBLIC_URL=http://localhost:3000`, `WEB_PORT=3000`, `COOKIE_SECURE=false`
  i `TRUST_PROXY_HOPS=0`. To tryb lokalnego testu jednego użytkownika: API widzi adres kontenera web,
  więc wielu użytkowników dzieliłoby limit prób logowania na IP, a audyt nie rozróżniałby ich adresów.
  Zmieniasz port → zmień też URL. Nie dodawaj końcowego `/` do URL.

Zawsze jawnie wskazuj `.env.docker`; lokalny deweloperski `.env` nie jest konfiguracją kontenerów.

```powershell
docker compose --env-file .env.docker config --quiet
docker compose --env-file .env.docker build
docker compose --env-file .env.docker up -d
docker compose --env-file .env.docker ps -a
docker compose --env-file .env.docker logs --tail 100 migrate clamav
```

`db` musi przejść healthcheck SQL, potem `migrate` zakończyć się kodem 0. API i worker czekają na migracje;
worker dodatkowo na gotowy skaner z sygnaturami. Frontend czeka na API. `migrate: Exited (0)` jest
oczekiwanym stanem jednorazowego zadania. Pozostałe kontenery powinny być `healthy`.

Otwórz <http://localhost:3000> i zaloguj się podanym loginem/e-mailem oraz hasłem z pliku
`.secrets/admin-password` (odczytaj lokalnie swoim edytorem; nie wklejaj go do logów).
Po zmianie hasła w aplikacji plik nie jest źródłem aktualnego hasła konta; ponowienie init go nie przywróci.

Host publikuje **wyłącznie frontend na 127.0.0.1**. SQL, API i clamd nie mają portów publicznych.
API w kontenerze słucha na `0.0.0.0:4000`, a Next przekazuje `/api` do `http://api:4000`.
Adres proxy jest wbudowany podczas `next build`; zmiana `API_INTERNAL_URL`/`NEXT_PUBLIC_API_URL`
wymaga przebudowania obrazu. Przeglądarka korzysta z `/api` w tej samej domenie.

## HTTPS — przykład z Caddy na hoście

Skonfiguruj DNS i certyfikat dla swojej domeny. Caddy działa **na hoście**, z dostępem do portu loopback 3000.
Przykładowy Caddyfile (zastąp domenę):

```caddyfile
aprobis.example.com {
    reverse_proxy 127.0.0.1:3000 {
        header_up X-Forwarded-For {remote_host}
    }
}
```

Ustaw `PUBLIC_URL=https://aprobis.example.com`, `COOKIE_SECURE=true`, `TRUST_PROXY_HOPS=1` i odtwórz
API oraz worker. W tym konkretnym układzie Caddy nadpisuje `X-Forwarded-For`, a Next zachowuje ten nagłówek;
API ufa jednemu przekazanemu adresowi. Nie zwiększaj liczby na podstawie samej liczby procesów proxy.
Przy dodatkowym CDN/proxy trzeba osobno ustalić zaufane nagłówki. Frontend nadal ma pozostać na loopback;
otwarcie jego portu do Internetu pozwoliłoby ominąć proxy czyszczące nagłówki. Reguły zapory publikują
tylko porty HTTPS/HTTP Caddy. Sprawdź logowanie, odrzucenie obcego `Origin`, flagę Secure cookie i rzeczywisty
adres klienta w audycie. Konfigurację SMTP wprowadź w Administracja → Konfiguracja.

## Dane, antywirus i obserwacja

- `database`: cała baza SQL; `storage`: załączniki; `logs`: dzienne pliki API/workera;
  `signatures`: sygnatury ClamAV. Nazwy wolumenów mają prefiks projektu Compose. Nie zmieniaj
  `COMPOSE_PROJECT_NAME` na istniejącej instalacji bez zaplanowanej migracji danych.
- API i worker montują załączniki pod **tym samym `/data/storage`**; ścieżki zapisane w bazie muszą
  pozostać zgodne. ClamAV dostaje bajty przez INSTREAM i nie potrzebuje montowania załączników.
- Limit uploadu aplikacji: 25 MiB, INSTREAM w clamd: 30 MiB. Ustawienia przekazuje Compose przez
  `CLAMD_CONF_*` do oficjalnego skryptu startowego obrazu. `AlertExceedsMax` odrzuca przekroczone
  limity skanowania archiwów zamiast dawać fałszywy wynik czysty.
- Domyślnie `AV_SCANNER=clamav`. `disabled` to świadome dopuszczenie nieskanowanych plików z etykietą
  „Nie skanowano”. Odtwórz **oba** kontenery API i worker po zmianie trybu. Po przywróceniu ClamAV worker
  ponownie kolejkuje takie pliki; do wyniku skanu nie można ich pobrać. Aby rzeczywiście nie uruchamiać
  ClamAV, ustaw `AV_SCANNER=disabled` i dodaj do **każdego** polecenia Compose
  `-f docker-compose.yml -f docker-compose.disabled.yml` (przed `up`, `run`, `down` itd.). Override usuwa
  zależność workera od skanera i umieszcza ClamAV w nieaktywnym profilu. Przy powrocie do skanowania
  usuń override, ustaw `AV_SCANNER=clamav` i uruchom zwykłe `up -d`, żeby odtworzyć workera i API.
- Health API/Next sprawdza odpowiedź HTTP i nazwę aplikacji (nie jest testem zapytań do bazy). Health workera
  wymaga postępu pętli i udanego kontaktu z bazą w ostatnich 5 minutach. `unhealthy` wymaga obserwacji operatora:
  Docker sam nie restartuje procesu tylko z powodu nieudanego healthchecku.
- SQL `sa` jest dostępne tylko w `db` i `migrate`; dane pierwszego administratora tylko w `migrate`.
  API/worker używają `aprobis_app` z rolami `db_datareader` i `db_datawriter`, bez `db_owner`/DDL.
  Web nie ma żadnego sekretu SQL. Runtime aplikacji działa jako użytkownik `node`, bez roota.

## Ponowienie, aktualizacja i kopie

`docker compose --env-file .env.docker up -d` zachowuje wolumeny. Init można ponowić:

```powershell
docker compose --env-file .env.docker run --rm migrate
```

Powinien zwrócić `ALREADY_INITIALIZED` dla istniejącego aktywnego administratora. Istniejącego hasła SQL
nie nadpisuje: jeśli sekret nie pasuje, kończy się błędem. Zmiana pliku `sql-sa-password` również **nie zmienia**
hasła w istniejącym wolumenie SQL. Rotację SQL wykonaj jako osobną, kontrolowaną operację w bazie i plikach.
Jeśli w bazie są użytkownicy, ale nie ma aktywnego administratora, init odmawia automatycznej naprawy.

Przed aktualizacją wykonaj i sprawdź kopię SQL (natywny `BACKUP DATABASE`) oraz kopię wolumenu `storage`,
plików sekretów i konfiguracji. Baza zawiera również jawne hasło SMTP, jeśli zapisano je w panelu.
Zatrzymaj zapisy na czas spójnego backupu bazy i załączników; przetestuj odtworzenie na osobnej instalacji.
Samo kopiowanie plików działającego SQL nie zastępuje prawidłowego backupu.

```powershell
docker compose --env-file .env.docker build
docker compose --env-file .env.docker stop web api worker
docker compose --env-file .env.docker run --rm migrate
# Kontynuuj tylko, jeśli migrate zakończył się kodem 0.
docker compose --env-file .env.docker up -d
```

Nie uruchamiaj starego API w trakcie zmiany schematu. Powrót do starego obrazu nie cofa migracji bazy.
`docker compose --env-file .env.docker down` usuwa kontenery i sieci, zachowując wolumeny.
**Nie używaj `down -v` na instalacji z danymi** — usuwa również bazę i załączniki.

## Test odbioru

1. Na nowym projekcie/wolumenach: poprawne logowanie jedynego administratora, brak kont demo.
2. Utwórz konto pracownika i przełożonego, dokument z małym PDF/PNG; załącznik przechodzi PENDING → CLEAN,
   można go pobrać. Administrator systemu sam nie wykonuje decyzji biznesowych.
3. W izolowanym teście skanera użyj standardowego pliku EICAR → REJECTED; aplikacja blokuje pobranie.
   Surowy plik `.com` może wcześniej odrzucić walidacja MIME — to nie dowód wykonania skanu.
4. Powtórz `migrate`, odtwórz kontenery i potwierdź zachowanie konta, zmienionego hasła, dokumentu oraz pliku.
5. Sprawdź role SQL, brak DDL konta aplikacji, brak opublikowanych portów SQL/API/clamd, uprawnienia plików
   oraz konfigurację HTTPS. Zanotuj wersje obrazów i wynik testu, zanim uznasz instalację za gotową.

Źródła: [kolejność Compose](https://docs.docker.com/compose/how-tos/startup-order/),
[ClamAV w Dockerze i wymagania RAM](https://docs.clamav.net/manual/Installing/Docker.html),
[SQL Server w kontenerze](https://learn.microsoft.com/en-us/sql/linux/quickstart-install-connect-docker?view=sql-server-ver17).
