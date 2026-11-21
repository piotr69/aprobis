<#
.SYNOPSIS
  Instalator Aprobis dla Windows Server: baza SQL Server, aplikacja (API, worker, frontend) i opcjonalnie IIS.

.DESCRIPTION
  Tryby:
    -Mode Check      tylko sprawdza wymagania, niczego nie zmienia
    -Mode Install    pierwsza instalacja: baza, konto SQL aplikacji, .env, build, migracje, dane startowe,
                     pierwszy administrator, zadania startowe, IIS (opcjonalnie)
    -Mode Upgrade    nowa wersja: build w katalogu tymczasowym, krotki postoj, migracje, start; .env bez zmian
    -Mode Uninstall  usuwa zadania, witryne IIS i regule zapory tej instalacji; pliki, dane i baza zostaja

  Plik bez polskich znakow: Windows PowerShell 5.1 czyta skrypty bez BOM w stronie kodowej systemu.

.EXAMPLE
  .\Install-Aprobis.ps1 -Mode Check -PublicUrl https://aprobis.firma.pl -ProxyMode IIS -CertificateThumbprint <odcisk>

.EXAMPLE
  .\Install-Aprobis.ps1 -Mode Install -PublicUrl https://aprobis.firma.pl -ProxyMode IIS -CertificateThumbprint <odcisk>

.EXAMPLE
  .\Install-Aprobis.ps1 -Mode Install -PublicUrl http://localhost:3000 -ProxyMode None -AntivirusMode disabled
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('Check', 'Install', 'Upgrade', 'Uninstall')][string]$Mode,
  # Zrodlo: katalog z kodem (domyslnie repozytorium, w ktorym lezy skrypt) albo paczka z New-Package.ps1.
  [string]$SourceDir,
  [string]$PackageZip,
  # Identyfikator instalacji: nazwy zadan, witryny IIS i reguly zapory. Dwie instalacje na jednym serwerze = dwa rozne.
  [ValidatePattern('^[A-Za-z][A-Za-z0-9_-]{1,30}$')][string]$InstanceName = 'Aprobis',
  [string]$AppRoot = 'C:\Apps\Aprobis',
  [string]$DataRoot = 'C:\ProgramData\Aprobis',
  # Adres, ktory ludzie wpisuja w przegladarce (FRONTEND_URL).
  [string]$PublicUrl,
  [int]$ApiPort = 4000,
  [int]$WebPort = 3000,
  # IIS: witryna z reverse proxy na frontend. None: wlasne proxy (nginx, Caddy) albo lokalne demo.
  [ValidateSet('IIS', 'None')][string]$ProxyMode = 'IIS',
  [string]$CertificateThumbprint,
  # Liczba proxy przed aplikacja. Domyslnie 1 dla IIS, 0 dla None.
  [int]$TrustProxyHops = -1,
  # SQL Server. Instalator laczy sie kontem Windows uruchamiajacego (albo -SqlAdminCredential) i zaklada
  # osobne konto SQL aplikacji z prawami tylko do odczytu i zapisu danych w tej bazie.
  [string]$SqlHost = '127.0.0.1',
  [int]$SqlPort = 1433,
  [ValidatePattern('^[A-Za-z][A-Za-z0-9_]{0,63}$')][string]$Database = 'Aprobis',
  [ValidatePattern('^[A-Za-z][A-Za-z0-9_]{0,63}$')][string]$AppLogin = 'aprobis_app',
  [System.Management.Automation.PSCredential]$SqlAdminCredential,
  [bool]$TrustServerCertificate = $true,
  [ValidateSet('defender', 'clamav', 'disabled')][string]$AntivirusMode = 'defender',
  [string]$ClamavHost = '127.0.0.1',
  [int]$ClamavPort = 3310,
  # Pierwszy administrator: bez tych zmiennych program zapyta w konsoli (haslo bez wyswietlania).
  [switch]$SkipAdmin
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Jawnie podane parametry: przy Upgrade/Uninstall wygrywaja z ustawieniami zapisanymi w .env.
$BoundParameters = $PSBoundParameters

# --- Stale i sciezki -------------------------------------------------------------------------------------------
if (-not $SourceDir -and -not $PackageZip) { $SourceDir = Split-Path $PSScriptRoot -Parent }
if ($TrustProxyHops -lt 0) { $TrustProxyHops = $(if ($ProxyMode -eq 'IIS') { 1 } else { 0 }) }

$taskNames = @("$InstanceName-Api", "$InstanceName-Worker", "$InstanceName-Web")
$envFile = Join-Path $AppRoot '.env'
$logsDir = Join-Path $DataRoot 'logs'
$storageDir = Join-Path $DataRoot 'storage'
$iisRoot = Join-Path $DataRoot 'iis'
$firewallRule = "$InstanceName HTTP(S)"
$apiScript = Join-Path $AppRoot 'backend\dist\server.js'
$workerScript = Join-Path $AppRoot 'backend\dist\worker.js'
$webScript = Join-Path $AppRoot 'node_modules\next\dist\bin\next'
# Katalogi i pliki, ktorych nigdy nie kopiujemy ze zrodla do instalacji.
$excludeDirs = @('.git', 'node_modules', '.next', 'dist', '.agents-inbox', '.claude', '.release', 'coverage')
$excludeFiles = @('.env', '.env.local', 'release.json', '*.log')

function Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Info([string]$Text) { Write-Host "    $Text" }
function Warn([string]$Text) { Write-Host "    UWAGA: $Text" -ForegroundColor Yellow }

function Invoke-Tool([string]$Command, [string]$WorkDir, [hashtable]$Environment = @{}) {
  # cmd /c, bo npm i npx to pliki .cmd. Wyjscie pokazujemy tylko przy bledzie.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $env:ComSpec
  $psi.Arguments = '/d /s /c "' + $Command + ' 2>&1"'
  $psi.WorkingDirectory = $WorkDir
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  foreach ($key in $Environment.Keys) { $psi.EnvironmentVariables[$key] = [string]$Environment[$key] }
  $process = [System.Diagnostics.Process]::Start($psi)
  $output = $process.StandardOutput.ReadToEnd()
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) {
    $tail = ($output -split "`r?`n" | Where-Object { $_ } | Select-Object -Last 25) -join "`n"
    throw "$Command zakonczone kodem $($process.ExitCode):`n$tail"
  }
  return $output
}

function New-Secret([int]$Length = 32) {
  # Tylko litery i cyfry: haslo trafia do adresu polaczenia i nie wymaga zadnego cytowania.
  $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'.ToCharArray()
  $bytes = New-Object byte[] $Length
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  do {
    $rng.GetBytes($bytes)
    $value = -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
  } until ($value -cmatch '[A-Z]' -and $value -cmatch '[a-z]' -and $value -match '[0-9]')
  return $value
}

function Get-DotEnvValue([string]$Path, [string]$Key) {
  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    if ($line -match "^\s*$Key\s*=\s*(.*)$") { return $Matches[1].Trim().Trim('"').Trim("'") }
  }
  return $null
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding $false))
}

# --- SQL Server --------------------------------------------------------------------------------------------------
function Get-AdminConnectionString([string]$Catalog) {
  $builder = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
  $builder['Data Source'] = "tcp:$SqlHost,$SqlPort"
  $builder['Initial Catalog'] = $Catalog
  $builder['TrustServerCertificate'] = $TrustServerCertificate
  $builder['Encrypt'] = $true
  if ($SqlAdminCredential) {
    $builder['User ID'] = $SqlAdminCredential.UserName
    $builder['Password'] = $SqlAdminCredential.GetNetworkCredential().Password
  } else {
    $builder['Integrated Security'] = $true
  }
  return $builder.ConnectionString
}

function Invoke-Sql([string]$Catalog, [string]$Sql, [hashtable]$Parameters = @{}, [switch]$Scalar) {
  # Parametry zamiast sklejania tekstu: nazwy i hasla nie moga zmienic polecenia SQL.
  $connection = New-Object System.Data.SqlClient.SqlConnection (Get-AdminConnectionString $Catalog)
  $connection.Open()
  try {
    $command = $connection.CreateCommand()
    $command.CommandText = $Sql
    $command.CommandTimeout = 300
    foreach ($key in $Parameters.Keys) { [void]$command.Parameters.AddWithValue($key, [string]$Parameters[$key]) }
    if ($Scalar) { return $command.ExecuteScalar() }
    [void]$command.ExecuteNonQuery()
  } finally {
    $connection.Close()
  }
}

function Get-PrismaUrl([string]$Login, [string]$Password) {
  $url = "sqlserver://$($SqlHost):$SqlPort;database=$Database;trustServerCertificate=$($TrustServerCertificate.ToString().ToLower())"
  if ($Login) { return "$url;user=$Login;password=$Password" }
  return "$url;integratedSecurity=true"
}

function Get-MigrationUrl {
  if ($SqlAdminCredential) {
    $password = $SqlAdminCredential.GetNetworkCredential().Password
    if ($password -match '[;={}]') { throw 'Haslo -SqlAdminCredential zawiera znak ; = { albo }: uzyj konta Windows albo innego hasla.' }
    return Get-PrismaUrl $SqlAdminCredential.UserName $password
  }
  return Get-PrismaUrl $null $null
}

function Initialize-Database([string]$AppPassword) {
  Step "Baza $Database na $($SqlHost):$SqlPort"
  Invoke-Sql 'master' @"
DECLARE @sql NVARCHAR(MAX);
IF DB_ID(@db) IS NULL
BEGIN
  SET @sql = N'CREATE DATABASE ' + QUOTENAME(@db) + N' COLLATE Polish_100_CI_AS';
  EXEC (@sql);
END
"@ @{ '@db' = $Database }

  $loginExists = [int](Invoke-Sql 'master' 'SELECT CASE WHEN SUSER_ID(@login) IS NULL THEN 0 ELSE 1 END' @{ '@login' = $AppLogin } -Scalar)
  if ($loginExists -and $AppPassword) {
    throw "Login SQL $AppLogin juz istnieje, a instalacja nie ma jego hasla. Nie zmieniam cudzego konta: podaj inny -AppLogin albo usun login."
  }
  if (-not $loginExists) {
    Info "Konto SQL aplikacji: $AppLogin"
    Invoke-Sql 'master' @"
DECLARE @sql NVARCHAR(MAX) = N'CREATE LOGIN ' + QUOTENAME(@login) + N' WITH PASSWORD = ' + QUOTENAME(@password, '''')
  + N', CHECK_POLICY = ON, DEFAULT_DATABASE = ' + QUOTENAME(@db);
EXEC (@sql);
"@ @{ '@login' = $AppLogin; '@password' = $AppPassword; '@db' = $Database }
  }
  # Aplikacja czyta i zapisuje dane; zmiany schematu robi tylko instalator swoim kontem.
  Invoke-Sql $Database @"
DECLARE @sql NVARCHAR(MAX);
IF USER_ID(@login) IS NULL
BEGIN
  SET @sql = N'CREATE USER ' + QUOTENAME(@login) + N' FOR LOGIN ' + QUOTENAME(@login);
  EXEC (@sql);
END
SET @sql = N'ALTER ROLE db_datareader ADD MEMBER ' + QUOTENAME(@login) + N'; ALTER ROLE db_datawriter ADD MEMBER ' + QUOTENAME(@login);
EXEC (@sql);
"@ @{ '@login' = $AppLogin }
}

# --- Procesy aplikacji -------------------------------------------------------------------------------------------
function Get-OwnProcess([string[]]$Scripts) {
  # Zadania uruchamiaja node z pelna sciezka w cudzyslowie: C:\Apps\Aprobis nie obejmuje C:\Apps\Aprobis2.
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $commandLine = $_.CommandLine
    $commandLine -and @($Scripts | Where-Object { $commandLine.IndexOf('"' + $_ + '"', [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count -gt 0
  })
}

function Stop-Application {
  foreach ($name in $taskNames) {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue }
  }
  $own = @($apiScript, $workerScript, $webScript)
  Get-OwnProcess $own | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  $left = @(Get-OwnProcess $own)
  if ($left.Count) { throw "Nie udalo sie zatrzymac procesow aplikacji: $($left.ProcessId -join ', ')" }
}

function Register-AppTask([string]$Name, [string]$Script, [string]$NodeArguments, [string]$WorkDir, [string]$LogName) {
  $node = (Get-Command node.exe).Source
  $log = Join-Path $logsDir $LogName
  $argument = '/d /c ""' + $node + '" "' + $Script + '" ' + $NodeArguments + ' >> "' + $log + '" 2>&1"'
  $action = New-ScheduledTaskAction -Execute $env:ComSpec -Argument $argument -WorkingDirectory $WorkDir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
  # Konto SYSTEM: Windows Defender (MpCmdRun) wymaga uprawnien do skanowania. Prawa do plikow ogranicza ACL ponizej.
  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
}

function Register-AppTasks {
  Step 'Zadania startowe (Harmonogram zadan)'
  Register-AppTask "$InstanceName-Api" $apiScript '' (Join-Path $AppRoot 'backend') 'api.log'
  Register-AppTask "$InstanceName-Worker" $workerScript '' (Join-Path $AppRoot 'backend') 'worker.log'
  Register-AppTask "$InstanceName-Web" $webScript "start `"$(Join-Path $AppRoot 'frontend')`" -p $WebPort -H 127.0.0.1" (Join-Path $AppRoot 'frontend') 'web.log'
}

function Start-Application { foreach ($name in $taskNames) { Start-ScheduledTask -TaskName $name } }

function Wait-Health([string]$Url, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 10
      # Sam status 200 nie wystarczy: odpowiedziec moze inna aplikacja albo domyslna strona IIS.
      $health = $response.Content | ConvertFrom-Json
      if ($health.status -eq 'ok' -and $health.app -eq 'aprobis-backend') { return $health }
    } catch { }
    Start-Sleep -Seconds 3
  }
  throw "Brak odpowiedzi Aprobis z $Url w ciagu $Seconds s. Sprawdz logi w $logsDir."
}

# --- Pliki -------------------------------------------------------------------------------------------------------
function Copy-Source([string]$Target) {
  $from = $SourceDir
  $unpacked = $null
  if ($PackageZip) {
    $unpacked = Join-Path $env:TEMP ("aprobis-" + [guid]::NewGuid().ToString('N'))
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
    [System.IO.Compression.ZipFile]::ExtractToDirectory((Resolve-Path $PackageZip), $unpacked)
    $from = $unpacked
  }
  try {
    # Nazwy (na kazdym poziomie, np. frontend\.next) oraz pelne sciezki danych: sama nazwa "logs"
    # pominelaby tez frontend\app\(app)\admin\logs.
    $xd = @($excludeDirs)
    $xd += @('backend\storage', 'backend\logs') | ForEach-Object { Join-Path $from $_ }
    & robocopy.exe $from $Target /MIR /NFL /NDL /NJH /NJS /NP /XD @xd /XF @excludeFiles | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Kopiowanie plikow nie powiodlo sie (robocopy $LASTEXITCODE)." }
  } finally {
    if ($unpacked) { Remove-Item -LiteralPath $unpacked -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

function Build-App([string]$Root) {
  Step "Zaleznosci i budowanie ($Root)"
  $buildEnv = @{ NEXT_PUBLIC_API_URL = '/api'; API_INTERNAL_URL = "http://127.0.0.1:$ApiPort" }
  Invoke-Tool 'npm ci --include=dev' $Root $buildEnv | Out-Null
  Invoke-Tool 'npm run db:generate' $Root $buildEnv | Out-Null
  Invoke-Tool 'npm run build' $Root $buildEnv | Out-Null
}

function Protect-Path([string]$Path, [string[]]$ReadOnlySids = @()) {
  # Tylko SYSTEM i Administratorzy: .env zawiera haslo do bazy, a dane to zalaczniki dokumentow.
  # $ReadOnlySids: konta z samym odczytem (np. IIS dla katalogu z web.config, bez sekretow).
  $grants = @('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F') + @($ReadOnlySids | ForEach-Object { "*$($_):(OI)(CI)RX" })
  & icacls.exe $Path /inheritance:r /grant:r @grants | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Nie udalo sie ustawic uprawnien do $Path." }
}

function New-EnvFile([string]$AppPassword) {
  $uri = [Uri]$PublicUrl
  $cookieSecure = $(if ($uri.Scheme -eq 'https') { '' } else { 'COOKIE_SECURE="false"' })
  $lines = @(
    '# Wygenerowane przez Install-Aprobis.ps1. Instalator nigdy nie nadpisuje tego pliku.',
    'NODE_ENV="production"',
    "DATABASE_URL=`"$(Get-PrismaUrl $AppLogin $AppPassword)`"",
    'HOST="127.0.0.1"',
    "PORT=$ApiPort",
    "FRONTEND_URL=`"$($PublicUrl.TrimEnd('/'))`"",
    "TRUST_PROXY_HOPS=$TrustProxyHops",
    # Ukosniki /: dotenv w cudzyslowach zamienia \n i \r na znaki konca linii (np. C:\new\...).
    "FILE_STORAGE_PATH=`"$($storageDir.Replace('\', '/'))`"",
    "LOG_PATH=`"$($logsDir.Replace('\', '/'))`"",
    "AV_SCANNER=`"$AntivirusMode`"",
    '# Ustawienia instalatora (aplikacja ich nie czyta); -Mode Upgrade bierze je stad.',
    "APROBIS_WEB_PORT=$WebPort",
    "APROBIS_PROXY_MODE=`"$ProxyMode`""
  )
  if ($AntivirusMode -eq 'clamav') { $lines += "CLAMAV_HOST=`"$ClamavHost`"", "CLAMAV_PORT=$ClamavPort" }
  if ($cookieSecure) { $lines += '# Adres http://: cookie sesji bez flagi Secure. Do produkcji uzyj HTTPS.', $cookieSecure }
  $lines += '# Poczte (SMTP) mozna ustawic tutaj albo w programie: Administracja -> Konfiguracja.'
  Write-Utf8NoBom $envFile (($lines -join "`r`n") + "`r`n")
  Protect-Path $envFile
}

function Write-Release([string]$Root) {
  $commit = $null
  if ($SourceDir -and (Test-Path (Join-Path $SourceDir '.git'))) { $commit = (& git -C $SourceDir rev-parse --short HEAD 2>$null) }
  if (-not $commit -and $PackageZip -and ([IO.Path]::GetFileNameWithoutExtension($PackageZip) -match '-([0-9a-f]{7,40})$')) { $commit = $Matches[1] }
  $release = [ordered]@{ commit = $commit; zainstalowano = (Get-Date).ToString('s'); instancja = $InstanceName }
  Write-Utf8NoBom (Join-Path $Root 'release.json') ($release | ConvertTo-Json)
}

# --- IIS -----------------------------------------------------------------------------------------------------------
function Test-IisPrerequisites {
  if (-not (Get-Module -ListAvailable -Name WebAdministration)) { throw 'Brak IIS (modul WebAdministration). Zainstaluj role Web Server albo uzyj -ProxyMode None.' }
  Import-Module WebAdministration
  if (-not (Get-WebGlobalModule -Name 'RewriteModule' -ErrorAction SilentlyContinue)) { throw 'Brak modulu IIS URL Rewrite.' }
  try { $proxyEnabled = (Get-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'enabled').Value }
  catch { throw 'Brak IIS Application Request Routing (sekcja system.webServer/proxy).' }
  if (-not $proxyEnabled) { throw 'Proxy w IIS ARR jest wylaczone (Application Request Routing -> Server Proxy Settings -> Enable proxy).' }
}

function Install-IisSite {
  Step "Witryna IIS $InstanceName"
  $uri = [Uri]$PublicUrl
  New-Item -ItemType Directory -Force -Path $iisRoot | Out-Null
  # IIS_IUSRS (pula aplikacji) i IUSR (ruch anonimowy) czytaja web.config; bez tego kazde zadanie to HTTP 500.19.
  Protect-Path $iisRoot @('S-1-5-32-568', 'S-1-5-17')
  $allowed = Get-WebConfiguration -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter "system.webServer/rewrite/allowedServerVariables/add[@name='HTTP_X_FORWARDED_FOR']"
  if (-not $allowed) {
    Info 'Dodaje HTTP_X_FORWARDED_FOR do allowedServerVariables (potrzebne, zeby API widzialo adres klienta).'
    Add-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/rewrite/allowedServerVariables' -Name '.' -Value @{ name = 'HTTP_X_FORWARDED_FOR' }
  }
  $webConfig = @"
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="$InstanceName-proxy" stopProcessing="true">
          <match url="(.*)" />
          <serverVariables>
            <set name="HTTP_X_FORWARDED_FOR" value="{REMOTE_ADDR}" />
          </serverVariables>
          <action type="Rewrite" url="http://127.0.0.1:$WebPort/{R:1}" appendQueryString="true" />
        </rule>
      </rules>
    </rewrite>
    <httpErrors existingResponse="PassThrough" />
    <security>
      <requestFiltering>
        <requestLimits maxAllowedContentLength="31457280" />
      </requestFiltering>
    </security>
  </system.webServer>
</configuration>
"@
  Write-Utf8NoBom (Join-Path $iisRoot 'web.config') $webConfig
  if (-not (Test-Path "IIS:\AppPools\$InstanceName")) { New-WebAppPool -Name $InstanceName | Out-Null }
  Set-ItemProperty "IIS:\AppPools\$InstanceName" -Name managedRuntimeVersion -Value ''
  $binding = "*:$($uri.Port):$($uri.Host)"
  if (-not (Get-Website -Name $InstanceName -ErrorAction SilentlyContinue)) {
    if ($uri.Scheme -eq 'https') {
      New-Website -Name $InstanceName -PhysicalPath $iisRoot -ApplicationPool $InstanceName -Port $uri.Port -HostHeader $uri.Host -Ssl -SslFlags 1 | Out-Null
    } else {
      New-Website -Name $InstanceName -PhysicalPath $iisRoot -ApplicationPool $InstanceName -Port $uri.Port -HostHeader $uri.Host | Out-Null
    }
  }
  if ($uri.Scheme -eq 'https') {
    $httpsBinding = Get-WebBinding -Name $InstanceName -Protocol https | Where-Object { $_.bindingInformation -eq $binding }
    if (-not $httpsBinding) { New-WebBinding -Name $InstanceName -Protocol https -Port $uri.Port -HostHeader $uri.Host -SslFlags 1 | Out-Null; $httpsBinding = Get-WebBinding -Name $InstanceName -Protocol https | Where-Object { $_.bindingInformation -eq $binding } }
    $httpsBinding.AddSslCertificate($CertificateThumbprint, 'My')
  }
  Get-NetFirewallRule -DisplayName $firewallRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $firewallRule -Direction Inbound -Action Allow -Protocol TCP -LocalPort $uri.Port | Out-Null
}

# --- Kontrola wstepna (bez zmian) ---------------------------------------------------------------------------------
function Test-Prerequisites {
  Step 'Kontrola wymagan (niczego nie zmienia)'
  $problems = New-Object System.Collections.Generic.List[string]
  $identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { $problems.Add('Uruchom PowerShell jako administrator.') }

  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) { $problems.Add('Brak Node.js 22+ (node.exe w PATH).') }
  else {
    $version = (& node.exe --version).TrimStart('v')
    if ([int]($version.Split('.')[0]) -lt 22) { $problems.Add("Wymagany Node.js 22 lub nowszy, jest $version.") } else { Info "Node.js $version" }
  }
  if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { $problems.Add('Brak npm w PATH.') }

  if ($Mode -in @('Install', 'Upgrade')) {
    if ($PackageZip) { if (-not (Test-Path -LiteralPath $PackageZip)) { $problems.Add("Brak paczki $PackageZip.") } }
    elseif (-not (Test-Path (Join-Path $SourceDir 'package.json'))) { $problems.Add("Brak kodu Aprobis w $SourceDir.") }
  }

  if ($Mode -in @('Check', 'Install')) {
    if (-not $PublicUrl) { $problems.Add('Podaj -PublicUrl, np. https://aprobis.firma.pl.') }
    else {
      try { $uri = [Uri]$PublicUrl } catch { $uri = $null }
      if (-not $uri -or $uri.Scheme -notin @('http', 'https')) { $problems.Add("Niepoprawny -PublicUrl: $PublicUrl") }
      else {
        if ($uri.Scheme -eq 'http') { Warn 'Adres http:// - haslo i sesja ida przez siec bez szyfrowania. Do produkcji uzyj HTTPS.' }
        if ($ProxyMode -eq 'IIS' -and $uri.Scheme -eq 'https') {
          if (-not $CertificateThumbprint) { $problems.Add('Dla https:// w trybie IIS podaj -CertificateThumbprint (certyfikat w LocalMachine\My).') }
          elseif (-not (Test-Path "Cert:\LocalMachine\My\$CertificateThumbprint")) { $problems.Add("Brak certyfikatu $CertificateThumbprint w LocalMachine\My.") }
        }
        try { [void][Net.Dns]::GetHostAddresses($uri.Host) } catch { Warn "Nazwa $($uri.Host) nie rozwiazuje sie w DNS z tego serwera (sprawdz wpis DNS)." }
      }
    }
    if (Test-Path -LiteralPath $envFile) { $problems.Add("Istnieje juz $envFile - to wyglada na zainstalowany program. Uzyj -Mode Upgrade.") }
    foreach ($port in @($ApiPort, $WebPort)) {
      $owner = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
      if ($owner) { $problems.Add("Port $port jest zajety (proces $(@($owner)[0].OwningProcess)).") }
    }
    try {
      $version = Invoke-Sql 'master' 'SELECT CAST(SERVERPROPERTY(''ProductVersion'') AS NVARCHAR(50))' -Scalar
      Info "SQL Server $version na $($SqlHost):$SqlPort"
      $canCreate = [int](Invoke-Sql 'master' 'SELECT CASE WHEN IS_SRVROLEMEMBER(''sysadmin'') = 1 OR (HAS_PERMS_BY_NAME(NULL, NULL, ''CREATE ANY DATABASE'') = 1 AND HAS_PERMS_BY_NAME(NULL, NULL, ''ALTER ANY LOGIN'') = 1) THEN 1 ELSE 0 END' -Scalar)
      if (-not $canCreate) { $problems.Add('Konto instalatora nie moze zakladac baz w SQL Server (potrzebne sysadmin albo CREATE ANY DATABASE + ALTER ANY LOGIN).') }
    } catch {
      $problems.Add("Brak polaczenia z SQL Server $($SqlHost):$SqlPort - $($_.Exception.Message)")
    }
  }

  if ($Mode -eq 'Upgrade') {
    if (-not (Test-Path -LiteralPath $envFile)) { $problems.Add("Brak $envFile - to nie jest zainstalowany Aprobis. Uzyj -Mode Install.") }
    else {
      foreach ($key in @('DATABASE_URL', 'FRONTEND_URL')) { if (-not (Get-DotEnvValue $envFile $key)) { $problems.Add("Brak $key w $envFile.") } }
      if ((Get-DotEnvValue $envFile 'HOST') -ne '127.0.0.1') { $problems.Add('W .env musi byc HOST="127.0.0.1": API nie moze byc dostepne z sieci.') }
      if (-not (Get-DotEnvValue $envFile 'AV_SCANNER')) { Warn 'Brak AV_SCANNER w .env - uzyty bedzie Windows Defender. Dopisz jawnie AV_SCANNER="defender".' }
    }
    # Polaczenie kontem migracji sprawdzamy przed budowaniem i zatrzymaniem dzialajacej aplikacji.
    try {
      [void](Invoke-Sql $Database 'SELECT 1' -Scalar)
      $canAlter = [int](Invoke-Sql $Database 'SELECT CASE WHEN IS_SRVROLEMEMBER(''sysadmin'') = 1 OR IS_ROLEMEMBER(''db_owner'') = 1 OR IS_ROLEMEMBER(''db_ddladmin'') = 1 THEN 1 ELSE 0 END' -Scalar)
      if (-not $canAlter) { $problems.Add("Konto instalatora nie moze zmieniac schematu bazy $Database (potrzebne db_owner albo db_ddladmin).") }
      else { Info "SQL Server $($SqlHost):$SqlPort, baza $($Database): OK" }
    } catch {
      $problems.Add("Brak polaczenia z baza $Database na $($SqlHost):$SqlPort - $($_.Exception.Message)")
    }
  }

  if ($Mode -in @('Check', 'Install') -and $AntivirusMode -eq 'defender') {
    $defender = @(
      (Join-Path $env:ProgramFiles 'Windows Defender\MpCmdRun.exe'),
      (Get-ChildItem (Join-Path $env:ProgramData 'Microsoft\Windows Defender\Platform') -Filter MpCmdRun.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName)
    ) | Where-Object { $_ -and (Test-Path $_) }
    if (-not $defender) { $problems.Add('Nie znaleziono Windows Defender (MpCmdRun.exe). Uzyj -AntivirusMode clamav albo disabled.') }
  }
  if ($Mode -in @('Check', 'Install') -and $AntivirusMode -eq 'clamav') {
    $client = New-Object Net.Sockets.TcpClient
    try { $client.Connect($ClamavHost, $ClamavPort) } catch { $problems.Add("Brak polaczenia z ClamAV (clamd) na $($ClamavHost):$ClamavPort.") } finally { $client.Dispose() }
  }
  if ($Mode -in @('Check', 'Install') -and $AntivirusMode -eq 'disabled') { Warn 'Skanowanie antywirusowe wylaczone: zalaczniki beda dostepne bez sprawdzenia.' }

  if ($Mode -in @('Check', 'Install', 'Upgrade') -and $ProxyMode -eq 'IIS') {
    try { Test-IisPrerequisites; Info 'IIS, URL Rewrite i ARR: OK' } catch { $problems.Add($_.Exception.Message) }
  }

  if ($problems.Count) {
    Write-Host ''
    Write-Host 'Instalacji nie mozna kontynuowac:' -ForegroundColor Red
    $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    throw "Kontrola wymagan: $($problems.Count) problem(y)."
  }
  Info 'Wszystkie wymagania spelnione.'
}

# --- Tryby ---------------------------------------------------------------------------------------------------------
function Invoke-Install {
  Test-Prerequisites
  New-Item -ItemType Directory -Force -Path $AppRoot, $DataRoot, $logsDir, $storageDir | Out-Null
  # Osobno logi i zalaczniki: katalog iis (web.config) musi byc czytelny dla IIS.
  Protect-Path $logsDir
  Protect-Path $storageDir

  Step "Kopiowanie plikow do $AppRoot"
  Copy-Source $AppRoot
  Build-App $AppRoot

  $appPassword = New-Secret
  Initialize-Database $appPassword
  New-EnvFile $appPassword
  $appPassword = $null

  Step 'Migracje i dane startowe'
  $migrationEnv = @{ DATABASE_URL = (Get-MigrationUrl) }
  Invoke-Tool 'npm run db:migrate:deploy' $AppRoot $migrationEnv | Out-Null
  Write-Host (Invoke-Tool 'npm run --silent db:bootstrap' $AppRoot $migrationEnv)

  if (-not $SkipAdmin) {
    Step 'Pierwszy administrator'
    # Bez przechwytywania wyjscia: program pyta w konsoli (haslo bez wyswietlania) albo czyta ADMIN_* ze srodowiska.
    $env:DATABASE_URL = Get-MigrationUrl
    try {
      Push-Location $AppRoot
      & npm.cmd run --silent db:create-admin
      if ($LASTEXITCODE -ne 0) { throw 'Nie utworzono administratora. Uruchom pozniej: npm run db:create-admin (w katalogu aplikacji).' }
    } finally {
      Pop-Location
      Remove-Item Env:\DATABASE_URL -ErrorAction SilentlyContinue
    }
  }

  Write-Release $AppRoot
  Register-AppTasks
  if ($ProxyMode -eq 'IIS') { Install-IisSite }

  Step 'Uruchomienie i kontrola'
  Start-Application
  Complete-HealthChecks
  Write-Host ''
  Write-Host "Gotowe: $PublicUrl" -ForegroundColor Green
  Info "Logi: $logsDir. Konfiguracja: $envFile."
}

function Complete-HealthChecks {
  $health = Wait-Health "http://127.0.0.1:$ApiPort/api/health" 120
  Info "API: OK (antywirus: $($health.antivirus))"
  [void](Wait-Health "http://127.0.0.1:$WebPort/api/health" 180)
  Info 'Frontend: OK'
  $public = Get-DotEnvValue $envFile 'FRONTEND_URL'
  if ($ProxyMode -eq 'IIS' -and $public) {
    try { [void](Wait-Health "$($public.TrimEnd('/'))/api/health" 60); Info "Adres publiczny: OK" }
    catch { Warn "Adres $public nie odpowiada z tego serwera (DNS, certyfikat albo zapora). Aplikacja dziala lokalnie." }
  }
  Start-Sleep -Seconds 5
  if (-not @(Get-OwnProcess @($workerScript)).Count) { throw "Worker nie dziala: zalaczniki nie przejda skanowania. Sprawdz $logsDir\worker.log." }
  Info 'Worker: dziala'
  $exposed = @(Get-NetTCPConnection -State Listen -LocalPort $ApiPort -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -ne '127.0.0.1' })
  if ($exposed.Count) { throw "API nasluchuje poza 127.0.0.1 ($($exposed[0].LocalAddress)). Sprawdz HOST w .env." }
}

function Use-InstalledSettings {
  # Upgrade/Uninstall dzialaja na ustawieniach z pierwszej instalacji (.env), nie na domyslnych parametrach.
  # Jawnie podany parametr wygrywa z .env.
  if (-not (Test-Path -LiteralPath $envFile)) { return }
  $explicit = $script:BoundParameters
  $port = Get-DotEnvValue $envFile 'PORT'
  if ($port -and -not $explicit.ContainsKey('ApiPort')) { $script:ApiPort = [int]$port }
  $web = Get-DotEnvValue $envFile 'APROBIS_WEB_PORT'
  if ($web -and -not $explicit.ContainsKey('WebPort')) { $script:WebPort = [int]$web }
  $proxy = Get-DotEnvValue $envFile 'APROBIS_PROXY_MODE'
  if ($proxy -in @('IIS', 'None') -and -not $explicit.ContainsKey('ProxyMode')) { $script:ProxyMode = $proxy }
  $logPath = Get-DotEnvValue $envFile 'LOG_PATH'
  if ($logPath) { $script:logsDir = [IO.Path]::GetFullPath($logPath) }
  $storagePath = Get-DotEnvValue $envFile 'FILE_STORAGE_PATH'
  if ($storagePath) { $script:storageDir = [IO.Path]::GetFullPath($storagePath) }
  # Serwer i baza z DATABASE_URL: sqlserver://host:port;database=X;...;trustServerCertificate=true
  $url = Get-DotEnvValue $envFile 'DATABASE_URL'
  if ($url -match '^sqlserver://([^:;]+)(?::(\d+))?') {
    if (-not $explicit.ContainsKey('SqlHost')) { $script:SqlHost = $Matches[1] }
    if ($Matches[2] -and -not $explicit.ContainsKey('SqlPort')) { $script:SqlPort = [int]$Matches[2] }
  }
  if ($url -match ';database=([^;]+)' -and -not $explicit.ContainsKey('Database')) { $script:Database = $Matches[1] }
  if ($url -match ';trustServerCertificate=(true|false)' -and -not $explicit.ContainsKey('TrustServerCertificate')) { $script:TrustServerCertificate = ($Matches[1] -eq 'true') }
  Info "Ustawienia instalacji: SQL $($script:SqlHost):$script:SqlPort/$script:Database, API $script:ApiPort, frontend $script:WebPort, proxy $script:ProxyMode, logi $script:logsDir"
}

function Invoke-Upgrade {
  Use-InstalledSettings
  Test-Prerequisites
  $staging = "$AppRoot.new"
  $previous = "$AppRoot" + '_prev'
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }

  # Nowa wersja budowana obok dzialajacej: postoj trwa tylko na czas zamiany katalogow i migracji.
  Step "Przygotowanie nowej wersji w $staging"
  Copy-Source $staging
  Build-App $staging

  Warn 'Przed aktualizacja zrob kopie bazy (BACKUP DATABASE) i katalogu danych. Kopia _prev cofa tylko kod, nie schemat bazy.'
  Step 'Zatrzymanie aplikacji'
  Stop-Application

  Step 'Zamiana katalogow'
  if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Recurse -Force }
  Rename-Item -LiteralPath $AppRoot -NewName (Split-Path $previous -Leaf)
  Rename-Item -LiteralPath $staging -NewName (Split-Path $AppRoot -Leaf)
  Copy-Item -LiteralPath (Join-Path $previous '.env') -Destination $envFile
  Protect-Path $envFile

  Step 'Migracje bazy'
  $migrationEnv = @{ DATABASE_URL = (Get-MigrationUrl) }
  Invoke-Tool 'npm run db:migrate:deploy' $AppRoot $migrationEnv | Out-Null
  Write-Host (Invoke-Tool 'npm run --silent db:bootstrap' $AppRoot $migrationEnv)

  Write-Release $AppRoot
  Register-AppTasks
  Step 'Uruchomienie i kontrola'
  Start-Application
  Complete-HealthChecks
  Write-Host ''
  Write-Host "Zaktualizowano. Poprzednia wersja kodu: $previous" -ForegroundColor Green
}

function Invoke-Uninstall {
  $identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Uruchom PowerShell jako administrator.' }
  Step "Odinstalowanie $InstanceName (pliki, dane i baza zostaja)"
  Stop-Application
  foreach ($name in $taskNames) {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; Info "Usunieto zadanie $name" }
  }
  # IIS i zapore tworzy tylko tryb IIS: w trybie None nie dotykamy zasobow o tej nazwie (moga nie byc nasze).
  if ($ProxyMode -eq 'IIS') {
    if (Get-Module -ListAvailable -Name WebAdministration) {
      Import-Module WebAdministration
      if (Get-Website -Name $InstanceName -ErrorAction SilentlyContinue) { Remove-Website -Name $InstanceName; Info "Usunieto witryne IIS $InstanceName" }
      if (Test-Path "IIS:\AppPools\$InstanceName") { Remove-WebAppPool -Name $InstanceName; Info "Usunieto pule aplikacji $InstanceName" }
    }
    Get-NetFirewallRule -DisplayName $firewallRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  }
  Info "Zostaly: $AppRoot, $DataRoot, baza $Database i login $AppLogin. Usun je recznie, jesli nie sa potrzebne."
}

switch ($Mode) {
  'Check' { Test-Prerequisites }
  'Install' { Invoke-Install }
  'Upgrade' { Invoke-Upgrade }
  'Uninstall' { Use-InstalledSettings; Invoke-Uninstall }
}
