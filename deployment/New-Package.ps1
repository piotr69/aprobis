<#
.SYNOPSIS
  Tworzy paczke instalacyjna Aprobis (zip) z repozytorium git.

.DESCRIPTION
  Do paczki trafiaja tylko pliki sledzone przez git (git archive): bez .env, logow, zalacznikow,
  node_modules ani notatek roboczych. Pliki oznaczone export-ignore w .gitattributes (testy, seed, narzedzia
  deweloperskie) sa pomijane.
  Domyslnie z ostatniego commitu (HEAD). -FromIndex bierze stan przygotowany w indeksie (git add),
  przydatne przed pierwszym commitem; niezatwierdzone zmiany spoza indeksu nie trafiaja do paczki.
#>
[CmdletBinding()]
param(
  [string]$Commit = 'HEAD',
  [switch]$FromIndex,
  [string]$OutDir
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo = Split-Path $PSScriptRoot -Parent
if (-not $OutDir) { $OutDir = Join-Path $repo '.release' }

if ($FromIndex) {
  $tree = (& git -C $repo write-tree).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'git write-tree nie powiodl sie.' }
  $label = 'index-' + $tree.Substring(0, 7)
} else {
  $tree = (& git -C $repo rev-parse --short $Commit).Trim()
  if ($LASTEXITCODE -ne 0) { throw "Nieznany commit: $Commit" }
  $label = $tree
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$zip = Join-Path (Resolve-Path $OutDir) "Aprobis-$(Get-Date -Format 'yyyyMMdd-HHmm')-$label.zip"
# Przy -FromIndex reguly export-ignore z biezacego .gitattributes (indeks moze miec starsza wersje).
$attributes = @(); if ($FromIndex) { $attributes = @('--worktree-attributes') }
& git -C $repo archive --format=zip @attributes -o $zip $tree
if ($LASTEXITCODE -ne 0) { throw 'git archive nie powiodl sie.' }
$zip
