# Test instalacji Aprobis na Windows Server

Lista kontrolna pełnego testu instalatora [`deployment/Install-Aprobis.ps1`](../deployment/Install-Aprobis.ps1) na czystej, nieprodukcyjnej maszynie. Celem jest przejście raz całej ścieżki (kontrola, instalacja, działanie w przeglądarce, restart, aktualizacja, IIS + HTTPS, odinstalowanie i przypadki brzegowe) oraz zapisanie wyniku każdego kroku (`OK` albo `BŁĄD` z dokładnym komunikatem).

Wszystkie polecenia instalatora uruchamiaj w **Windows PowerShell jako administrator**, z katalogu `deployment` (np. `cd C:\Instalki\aprobis\deployment`). Opisy parametrów: [docs/instalacja-windows.md](instalacja-windows.md).

---

## A. Środowisko testowe

Przygotuj czystą, nieprodukcyjną maszynę wirtualną i wykonaj **migawkę (snapshot) przed testem**:

- **System:** Windows Server 2022 (lub Windows Server 2019), 4 vCPU, 8 GB RAM, 60 GB dysku.
- **SQL Server:** SQL Server 2022 Express z włączonym protokołem TCP na porcie `1433` (konto uruchamiające instalator z uprawnieniami `sysadmin` albo `CREATE ANY DATABASE` + `ALTER ANY LOGIN`, ewentualnie osobny login SQL przez `-SqlAdminCredential`).
- **Node.js:** Node.js 22 LTS w `PATH` (oraz dostęp do rejestru npm na czas `npm ci`).
- **IIS (dla wariantu G):** rola Web Server (IIS), moduły **URL Rewrite** oraz **Application Request Routing (ARR)** z włączonym proxy (*ARR → Server Proxy Settings → Enable proxy*).
- **Certyfikat (opcjonalnie dla wariantu G z HTTPS):** certyfikat testowy (np. samopodpisany) zapisany w magazynie `Cert:\LocalMachine\My` dla testowej nazwy hosta.
- **Antywirus:** Windows Defender włączony (dostępny `MpCmdRun.exe`).
- **Źródła Aprobis:** pobrana paczka `aprobis-0.0.1-package.zip` z wydania `v0.0.1` (używana przez `-PackageZip`) albo klon repozytorium (`git clone`, używany przez `-SourceDir`).

Zapisz przed rozpoczęciem dokładne wersje środowiska:

- Windows Server: `...` (np. `[System.Environment]::OSVersion.VersionString`)
- SQL Server: `...` (`sqlcmd -S 127.0.0.1,1433 -E -I -Q "SELECT @@VERSION"`)
- Node.js / npm: `...` (`node --version`, `npm --version`)
- Paczka / commit Aprobis: `...`

---

## B. Kontrola (`-Mode Check`)

1. Uruchom kontrolę dla wariantu bez IIS:
   ```powershell
   .\Install-Aprobis.ps1 -Mode Check -PublicUrl http://localhost:3000 -ProxyMode None
   ```
2. Uruchom kontrolę dla wariantu IIS (HTTP oraz HTTPS z odciskiem certyfikatu z `Cert:\LocalMachine\My`):
   ```powershell
   .\Install-Aprobis.ps1 -Mode Check -PublicUrl http://aprobis.test.local -ProxyMode IIS
   .\Install-Aprobis.ps1 -Mode Check -PublicUrl https://aprobis.test.local -ProxyMode IIS -CertificateThumbprint <odcisk>
   ```
   - **Oczekiwane:** lista wykrytych braków (jeśli czegoś brakuje) albo komunikat `Wszystkie wymagania spelnione.`; ostrzeżenie o `http://` przy adresie bez TLS; ostrzeżenie DNS, jeśli nazwa nie rozwiązuje się jeszcze z serwera.
3. **Test negatywny:** celowo zepsuj jedno wymaganie — np. zatrzymaj usługę SQL Server (`Stop-Service 'MSSQL$SQLEXPRESS'`) i powtórz `-Mode Check`.
   - **Oczekiwane:** kontrola kończy się błędem wskazującym brak połączenia z SQL Server i **niczego nie zmienia** (brak `C:\Apps\Aprobis`, brak `C:\ProgramData\Aprobis`, brak zadań w Harmonogramie, brak witryny IIS). Po sprawdzeniu uruchom usługę SQL z powrotem.

---

## C. Instalacja HTTP bez IIS (najprostsza)

1. Uruchom instalację z domyślnym skanerem Defender (lub dopisz `-PackageZip C:\Instalki\aprobis-0.0.1-package.zip`, jeśli instalujesz z paczki):
   ```powershell
   .\Install-Aprobis.ps1 -Mode Install -PublicUrl http://localhost:3000 -ProxyMode None
   ```
2. Podczas kroku zakładania pierwszego administratora wpisz w konsoli e-mail, login, imię, nazwisko oraz hasło (powinno wpisywać się bez wyświetlania znaków, z powtórzeniem).
3. Zweryfikuj stan po zakończeniu:
   - **Kontrole końcowe instalatora:** zakończone komunikatem `Gotowe: http://localhost:3000` (bez błędów API, frontendu, workera i nasłuchu).
   - **Health API:**
     ```powershell
     Invoke-RestMethod http://127.0.0.1:4000/api/health
     ```
     Oczekiwane: `status: ok`, `app: aprobis-backend`, `antivirus: defender`.
   - **Harmonogram zadań:**
     ```powershell
     Get-ScheduledTask -TaskName 'Aprobis-*' | Format-Table TaskName, State -AutoSize
     ```
     Oczekiwane: trzy zadania `Aprobis-Api`, `Aprobis-Worker`, `Aprobis-Web` w stanie `Running`.
   - **Uprawnienia NTFS (ACL):**
     ```powershell
     icacls C:\Apps\Aprobis\.env
     icacls C:\ProgramData\Aprobis\logs
     icacls C:\ProgramData\Aprobis\storage
     ```
     Oczekiwane: dostęp wyłącznie dla `NT AUTHORITY\SYSTEM` oraz `BUILTIN\Administrators` (bez dziedziczenia dla zwykłych użytkowników).
   - **Prawa konta SQL `aprobis_app`:**
     ```powershell
     sqlcmd -S 127.0.0.1,1433 -E -I -d Aprobis -Q "SELECT IS_ROLEMEMBER('db_datareader','aprobis_app') AS reader, IS_ROLEMEMBER('db_datawriter','aprobis_app') AS writer, IS_ROLEMEMBER('db_owner','aprobis_app') AS owner, IS_SRVROLEMEMBER('sysadmin','aprobis_app') AS sysadmin"
     ```
     Oczekiwane: `reader = 1`, `writer = 1`, `owner = 0`, `sysadmin = 0`.

---

## D. Test funkcjonalny w przeglądarce

Otwórz `http://localhost:3000` w przeglądarce na maszynie testowej:

1. Zaloguj się kontem pierwszego administratora utworzonym w kroku C. Potwierdź brak kont demonstracyjnych.
2. W panelu administracyjnym utwórz dział, konto pracownika (rola `Pracownik`) oraz konto przełożonego (np. `Kierownik działu` — inna rola niż administrator systemu, który celowo nie zatwierdza dokumentów biznesowych) i ustaw przełożonego pracownikowi.
3. Zaloguj się jako pracownik, utwórz dokument (np. fakturę kosztową) i dodaj niewielki załącznik PDF:
   - **Oczekiwane:** status skanu przechodzi z `Skanowanie…` na `Bezpieczny`, plik daje się pobrać i otworzyć z identyczną treścią.
4. Przygotuj standardowy plik testowy **EICAR** (pobrany ze strony `eicar.org`, zapisany z rozszerzeniem `.txt`, aby przeszedł aplikacyjną walidację formatu) i wgraj go jako załącznik:
   - *Uwaga:* Windows Defender na maszynie testowej może usunąć plik EICAR już przy zapisie na dysku; przygotuj go tuż przed wysłaniem albo wyklucz tymczasowy katalog roboczy w Defenderze (nie wykluczaj katalogu `C:\ProgramData\Aprobis\storage` — tam Defender musi wykryć zagrożenie).
   - **Oczekiwane:** załącznik otrzymuje status `Zablokowany przez antywirus`, pobranie jest zablokowane, a złożenie dokumentu z zablokowanym załącznikiem jest niemożliwe aż do usunięcia tego pliku.
5. Usuń zablokowany plik testowy, złóż dokument z bezpiecznym PDF do akceptacji.
6. Zaloguj się jako przełożony, otwórz zadanie w *Do zrobienia przeze mnie* i zatwierdź dokument (z komentarzem).
   - **Oczekiwane:** dokument przechodzi do stanu zakończonego (`Zatwierdzony`), ścieżka akceptacji i *Historia* pokazują decyzję, a *Audyt* (widoczny dla administratora) rejestruje zdarzenia pliku i decyzji.

---

## E. Restart serwera

1. Zrestartuj maszynę wirtualną (`Restart-Computer`).
2. Po ponownym uruchomieniu zaloguj się i odczekaj ok. 30–60 s.
3. Sprawdź:
   - wszystkie trzy zadania `Aprobis-Api`, `Aprobis-Worker`, `Aprobis-Web` uruchomiły się automatycznie (`Running`),
   - `http://127.0.0.1:4000/api/health` odpowiada `status: ok`, `app: aprobis-backend`,
   - logowanie w `http://localhost:3000` działa, dokument z kroku D istnieje, a załącznik PDF nadal można pobrać.

---

## F. Aktualizacja (`-Mode Upgrade`)

1. Wykonaj kopię bazy przed aktualizacją:
   ```powershell
   sqlcmd -S 127.0.0.1,1433 -E -I -Q "BACKUP DATABASE [Aprobis] TO DISK = N'C:\ProgramData\Aprobis\Aprobis-before-upgrade.bak' WITH INIT"
   ```
2. Zapisz skrót (hash) pliku `.env` przed aktualizacją (`Get-FileHash C:\Apps\Aprobis\.env`).
3. Uruchom aktualizację z tej samej lub nowszej wersji źródeł (albo `-PackageZip`):
   ```powershell
   .\Install-Aprobis.ps1 -Mode Upgrade -SourceDir C:\Instalki\aprobis
   ```
4. Zweryfikuj:
   - **Oczekiwane:** aplikacja buduje się w `C:\Apps\Aprobis.new` przed zatrzymaniem usług, postój trwa krótko, kontrole końcowe przechodzą `OK`.
   - Skrót `C:\Apps\Aprobis\.env` nie zmienił się (plik nie został nadpisany).
   - Katalog `C:\Apps\Aprobis_prev` istnieje.
   - Zalogowanie się dotychczasowym hasłem administratora działa, a dokumenty i załączniki z kroku D są zachowane.

---

## G. Wariant IIS + HTTPS

Wykonaj na **czystej migawce** z punktu A (albo po wykonaniu kroku H i ręcznym usunięciu `C:\Apps\Aprobis`, `C:\ProgramData\Aprobis`, bazy `Aprobis` i loginu `aprobis_app`):

1. Dodaj wpis DNS (lub wpis w `C:\Windows\System32\drivers\etc\hosts` na serwerze i stacji klienckiej) kierujący wybraną nazwę (np. `aprobis.test.local`) na adres IP serwera.
2. Odczytaj odcisk certyfikatu w `LocalMachine\My`:
   ```powershell
   Get-ChildItem Cert:\LocalMachine\My | Format-Table Subject, Thumbprint, NotAfter -AutoSize
   ```
3. Uruchom instalację w trybie IIS + HTTPS:
   ```powershell
   .\Install-Aprobis.ps1 -Mode Install -PublicUrl https://aprobis.test.local -ProxyMode IIS -CertificateThumbprint <odcisk>
   ```
4. Zweryfikuj:
   - W IIS istnieje witryna i pula aplikacji `Aprobis` z wiązaniem `https` (SNI) i podpiętym certyfikatem, a katalog `C:\ProgramData\Aprobis\iis` ma uprawnienia odczytu dla `IIS_IUSRS` i `IUSR` (brak błędu HTTP 500.19).
   - Istnieje reguła zapory `Aprobis HTTP(S)` otwierająca port `443` (porty `3000` i `4000` nasłuchują wyłącznie na `127.0.0.1`).
   - Logowanie przez `https://aprobis.test.local` z przeglądarki (najlepiej z drugiej maszyny w sieci) działa; ciasteczko sesji `aprobis_session` ma flagę `Secure` i `HttpOnly` (sprawdź w DevTools → Application → Cookies).
   - W ekranie *Audyt* wpis logowania pokazuje **prawdziwy adres IP klienta**, a nie `127.0.0.1`.

---

## H. Odinstalowanie (`-Mode Uninstall`)

1. Uruchom:
   ```powershell
   .\Install-Aprobis.ps1 -Mode Uninstall
   ```
2. Zweryfikuj:
   - Zadania `Aprobis-Api`, `Aprobis-Worker`, `Aprobis-Web` zostały usunięte, a procesy `node.exe` tej instalacji nie działają.
   - W wariancie IIS: witryna IIS `Aprobis`, pula aplikacji `Aprobis` oraz reguła zapory `Aprobis HTTP(S)` zostały usunięte.
   - **Dane zachowane:** katalogi `C:\Apps\Aprobis` i `C:\ProgramData\Aprobis`, baza `Aprobis` oraz login SQL `aprobis_app` pozostały nietknięte.

---

## I. Przypadki brzegowe

1. **Ponowny `-Mode Install` przy istniejącym `.env`:** uruchom `-Mode Install` na katalogu, w którym istnieje już `C:\Apps\Aprobis\.env`.
   - **Oczekiwane:** preflight odmawia instalacji z komunikatem wskazującym użycie `-Mode Upgrade`, nic nie zostaje nadpisane.
2. **Istniejący login SQL bez hasła (`-AppLogin`):** utwórz ręcznie w SQL Server testowy login (np. `aprobis_istniejacy`), a następnie uruchom `-Mode Install` na czystym `-AppRoot` z `-AppLogin aprobis_istniejacy`.
   - **Oczekiwane:** instalator przerywa z błędem informującym, że login już istnieje i nie jest przejmowany; hasło istniejącego loginu w SQL pozostaje niezmienione.
3. **Docker Desktop na tej samej maszynie (opcjonalnie, jeśli obecny):** sprawdź, czy połączenie z `127.0.0.1` zwraca błąd `Login failed. The login is from an untrusted domain and cannot be used with Integrated authentication`, i potwierdź działanie jednego z obejść opisanych w sekcji *Rozwiązywanie problemów* w [docs/instalacja-windows.md](instalacja-windows.md#rozwiązywanie-problemów) (np. `-SqlAdminCredential`).

---

## J. Raport z testu

Uzupełnij tabelę po zakończeniu testu i w razie znalezienia problemów zgłoś je w **GitHub Issues** projektu. Do zgłoszenia dołącz fragmenty logów z `C:\ProgramData\Aprobis\logs` (`api.log`, `worker.log`, `web.log`) oraz dokładny komunikat z konsoli — **przed wysłaniem usuń wszelkie hasła i nigdy nie załączaj pliku `.env`**.

| Sekcja | Krok | Wynik (`OK` / `BŁĄD` / `Pominięto`) | Uwagi / komunikat błędu |
| --- | --- | --- | --- |
| A | Środowisko i migawka przygotowane | | |
| B | `-Mode Check` (None, IIS HTTP/HTTPS, test negatywny) | | |
| C | `-Mode Install` HTTP bez IIS + health + zadania + ACL + role SQL | | |
| D | Przeglądarka: admin, role, PDF `Bezpieczny`, EICAR `Zablokowany`, akceptacja, audyt | | |
| E | Restart serwera — autostart i zachowanie danych | | |
| F | `-Mode Upgrade` — kopia bazy, `_prev`, niezmieniony `.env`, zachowane dane | | |
| G | Wariant IIS + HTTPS — wiązanie, zapora, cookie `Secure`, IP klienta w audycie | | |
| H | `-Mode Uninstall` — usunięcie zasobów, zachowanie danych i bazy | | |
| I | Przypadki brzegowe (istniejący `.env`, istniejący `-AppLogin`, ew. Docker Desktop) | | |
