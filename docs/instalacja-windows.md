# Instalacja Aprobis na Windows Server

Instalator: `deployment/Install-Aprobis.ps1`. Uruchamiaj w **Windows PowerShell jako administrator**.

## Wymagania

- Windows Server 2019/2022 (lub Windows 10/11 do testów).
- **Node.js 22+** (w `PATH`) i dostęp do rejestru npm (instalator wykonuje `npm ci`).
- **SQL Server** (wystarczy Express) z włączonym TCP. Konto uruchamiające instalator (Windows) albo
  `-SqlAdminCredential` musi móc zakładać bazy i loginy (`sysadmin` albo `CREATE ANY DATABASE` + `ALTER ANY LOGIN`).
- Skaner załączników: **Windows Defender** (domyślnie), **ClamAV** (`clamd` dostępny po TCP) albo świadomie wyłączony.
- Dla `-ProxyMode IIS`: rola Web Server (IIS), moduły **URL Rewrite** i **Application Request Routing** z włączonym
  proxy (ARR → *Server Proxy Settings* → *Enable proxy*). Dla adresu `https://` — certyfikat w `LocalMachine\My`.

## 1. Kontrola (niczego nie zmienia)

```powershell
cd C:\Instalki\aprobis\deployment
.\Install-Aprobis.ps1 -Mode Check -PublicUrl https://aprobis.firma.pl -ProxyMode IIS -CertificateThumbprint <odcisk>
```

Kontrola sprawdza uprawnienia, Node.js, połączenie i prawa w SQL Server, wolne porty, IIS/URL Rewrite/ARR,
certyfikat, DNS (ostrzeżenie) i dostępność skanera. Przy jakimkolwiek problemie kończy się błędem z listą braków.

## 2. Pierwsza instalacja

```powershell
.\Install-Aprobis.ps1 -Mode Install -PublicUrl https://aprobis.firma.pl -ProxyMode IIS -CertificateThumbprint <odcisk>
```

Kolejno: kontrola → kopia plików do `C:\Apps\Aprobis` → `npm ci` i build → baza `Aprobis` i konto SQL `aprobis_app`
(losowe hasło, tylko odczyt/zapis danych) → `.env` (uprawnienia: SYSTEM i Administratorzy) → migracje i dane
startowe (role, typy dokumentów, waluty) → **pierwszy administrator** (program zapyta o e-mail, imię, nazwisko
i hasło; hasło bez wyświetlania) → zadania startowe → witryna IIS i reguła zapory → kontrola działania.

Najważniejsze parametry (wartości domyślne w nawiasach):

| Parametr | Znaczenie |
|---|---|
| `-PublicUrl` | adres wpisywany w przeglądarce (wymagany) |
| `-ProxyMode` | `IIS` (domyślnie) albo `None` — własne proxy (nginx, Caddy) lub lokalne demo |
| `-InstanceName` | identyfikator instalacji (`Aprobis`): nazwy zadań, witryny IIS i reguły zapory |
| `-AppRoot` / `-DataRoot` | kod (`C:\Apps\Aprobis`) / dane: załączniki, logi (`C:\ProgramData\Aprobis`) |
| `-ApiPort` / `-WebPort` | porty lokalne API (`4000`) i frontendu (`3000`), nasłuch tylko na `127.0.0.1` |
| `-SqlHost` / `-SqlPort` / `-Database` | SQL Server (`127.0.0.1`, `1433`, `Aprobis`) |
| `-SqlAdminCredential` | login SQL instalatora, gdy nie konto Windows |
| `-AppLogin` | konto SQL aplikacji (`aprobis_app`); istniejącego loginu instalator nie przejmuje |
| `-AntivirusMode` | `defender` (domyślnie), `clamav` (+ `-ClamavHost`, `-ClamavPort`) albo `disabled` |
| `-TrustProxyHops` | liczba proxy przed aplikacją (1 dla IIS, 0 dla None) |
| `-SourceDir` / `-PackageZip` | źródło: katalog z kodem (domyślnie repozytorium) albo paczka z `New-Package.ps1` |
| `-SkipAdmin` | bez zakładania administratora (później: `npm run db:create-admin` w katalogu aplikacji) |

Pierwszego administratora można też podać bez pytań (automatyzacja): zmienne środowiskowe `ADMIN_EMAIL`,
`ADMIN_LOGIN`, `ADMIN_FIRST_NAME`, `ADMIN_LAST_NAME` oraz `ADMIN_PASSWORD` albo `ADMIN_PASSWORD_FILE`.
Nie są zapisywane w `.env`. Instalator nie tworzy kont demonstracyjnych ani przykładowych dokumentów.

Jeśli instalacja przerwie się po utworzeniu `.env` (np. błąd migracji), ponowne `-Mode Install` odmówi
(program jest już częściowo zainstalowany). Usuń przyczynę i dokończ: `-Mode Upgrade` (migracje, dane startowe,
zadania), a potem `npm run db:create-admin` w katalogu aplikacji.

Lokalne demo bez IIS:

```powershell
.\Install-Aprobis.ps1 -Mode Install -PublicUrl http://localhost:3000 -ProxyMode None -AntivirusMode disabled
```

Adres `http://` ustawia `COOKIE_SECURE="false"`. Do produkcji używaj HTTPS.

## 3. Aktualizacja

1. Zrób kopię bazy (`BACKUP DATABASE`) i katalogu danych.
2. `.\Install-Aprobis.ps1 -Mode Upgrade -SourceDir <nowa wersja>` (albo `-PackageZip`).

Nowa wersja jest budowana obok działającej (`C:\Apps\Aprobis.new`); postój trwa tylko na czas zamiany katalogów
i migracji. `.env` zostaje bez zmian. Poprzedni kod zostaje w `C:\Apps\Aprobis_prev` — przywraca on tylko kod,
**nie** schemat bazy (do tego służy kopia bazy).

## 4. Odinstalowanie

```powershell
.\Install-Aprobis.ps1 -Mode Uninstall
```

Usuwa zadania tej instalacji, a przy instalacji z IIS także witrynę, pulę i regułę zapory. Pliki, dane, baza i login SQL zostają.

## Jak to działa po instalacji

- Trzy zadania Harmonogramu (konto SYSTEM, start przy rozruchu, ponawianie co minutę po awarii):
  `<InstanceName>-Api`, `<InstanceName>-Worker`, `<InstanceName>-Web`. Logi: `C:\ProgramData\Aprobis\logs`.
- IIS przyjmuje ruch na `-PublicUrl` i przekazuje go do frontendu; frontend kieruje `/api` do API.
  API i frontend nasłuchują tylko na `127.0.0.1`.
- Stan: `http://127.0.0.1:4000/api/health` — m.in. tryb skanera (`antivirus`).

## Ręczne założenie bazy przez DBA

Jeśli instalator nie może dostać praw do zakładania baz: `deployment/Create-Database.sql` (instrukcja w nagłówku pliku),
potem w `.env` adres konta aplikacji, a migracje uruchamia DBA swoim kontem.

## Paczka instalacyjna

`deployment/New-Package.ps1` tworzy zip z plików śledzonych przez git (`-FromIndex`: ze stanu w indeksie przed commitem).
Bez testów, danych demonstracyjnych (`prisma/seed.ts`), skryptów deweloperskich i dokumentów dla kontrybutorów —
lista w `.gitattributes` (`export-ignore`).
