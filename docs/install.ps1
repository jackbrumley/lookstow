# Lookstow installer for Windows (docs/RELEASE.md).
#
# In PowerShell as Administrator:
#   irm https://brumley.info/lookstow/install.ps1 | iex
# With options:
#   & ([scriptblock]::Create((irm https://brumley.info/lookstow/install.ps1))) -Version v0.1.0
#
# Downloads the newest release from GitHub, checks it against the release's
# SHA256SUMS, and runs `lookstow.exe install`, which copies it to
# C:\Program Files\Lookstow, keeps its data in C:\ProgramData\Lookstow and
# starts the Lookstow service. From then on Lookstow updates itself (Update
# now on the console's Updates page). Running this again upgrades in place and
# keeps the data. Then it waits for the console and prints its address.
param(
	# Install this release (for example v0.1.0) instead of the newest.
	[string]$Version = '',
	# Console port for a new install (default 8030); an upgrade keeps its port.
	[int]$Port = 0,
	# Program folder (default C:\Program Files\Lookstow).
	[string]$Prefix = '',
	# Data folder (default C:\ProgramData\Lookstow).
	[string]$DataDir = '',
	# Install the files and settings only: no service, no Administrator needed.
	[switch]$NoService,
	# Install this release archive (lookstow-windows-x64.zip) instead of downloading one.
	[string]$Archive = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0
# The progress bar makes Invoke-WebRequest many times slower in Windows PowerShell.
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
# Windows PowerShell started from PowerShell 7, or from a program started
# there, inherits PowerShell 7's module folders, loads PowerShell 7's modules,
# and can't find commands such as Get-FileHash. Keep only the other folders;
# Windows PowerShell's own are named WindowsPowerShell.
if ($PSVersionTable.PSEdition -ne 'Core') {
	$env:PSModulePath = ($env:PSModulePath -split ';' | Where-Object { $_ -and $_ -notmatch '\\PowerShell\\' }) -join ';'
}

$Repo = 'jackbrumley/lookstow'
$Asset = 'lookstow-windows-x64.zip'

function Say([string]$Message) {
	Write-Host "lookstow: $Message"
}

# Throws rather than exits: under `irm | iex` an exit would close the window.
function Fail([string]$Message) {
	throw "lookstow: $Message"
}

function Test-Sha256([string]$File, [string]$SumsFile) {
	$expected = $null
	foreach ($line in Get-Content -LiteralPath $SumsFile) {
		$fields = $line.Trim() -split '\s+'
		if ($fields.Count -ge 2 -and $fields[1].TrimStart('*') -eq $Asset) {
			$expected = $fields[0].ToLowerInvariant()
		}
	}
	if ($null -eq $expected) { Fail "$Asset is not listed in SHA256SUMS" }
	$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $File).Hash.ToLowerInvariant()
	if ($expected -ne $actual) { Fail "$Asset does not match SHA256SUMS (expected $expected, got $actual)" }
	Say 'Checksum verified.'
}

if ($env:OS -ne 'Windows_NT') { Fail 'this installer is for Windows; on Linux use install.sh' }
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($arch -ne 'AMD64') { Fail "there is no Lookstow for Windows on $arch yet" }

if (-not $NoService) {
	$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
	if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
		Fail 'run PowerShell as Administrator (right-click, Run as administrator) and try again'
	}
}
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
	Fail 'this installer needs curl.exe, which comes with Windows 10 (1803) and later'
}

if ($Prefix -eq '') { $Prefix = Join-Path $env:ProgramFiles 'Lookstow' }
if ($DataDir -eq '') { $DataDir = Join-Path $env:ProgramData 'Lookstow' }

$work = Join-Path ([IO.Path]::GetTempPath()) ('lookstow-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
	$zip = Join-Path $work $Asset
	if ($Archive -ne '') {
		if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) { Fail "$Archive does not exist" }
		Copy-Item -LiteralPath $Archive -Destination $zip
		$sums = Join-Path (Split-Path -Parent (Resolve-Path -LiteralPath $Archive)) 'SHA256SUMS'
		if (Test-Path -LiteralPath $sums) { Test-Sha256 $zip $sums } else { Say "No SHA256SUMS beside $Archive, so it was not checked." }
	} else {
		# Asset names carry no version, so the newest release needs no GitHub API call.
		$base = if ($Version -ne '') { "https://github.com/$Repo/releases/download/$Version" } else { "https://github.com/$Repo/releases/latest/download" }
		Say "Downloading $base/$Asset"
		try {
			Invoke-WebRequest -UseBasicParsing -Uri "$base/$Asset" -OutFile $zip
			Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile (Join-Path $work 'SHA256SUMS')
		} catch {
			Fail "could not download the release ($($_.Exception.Message))"
		}
		Test-Sha256 $zip (Join-Path $work 'SHA256SUMS')
	}

	Expand-Archive -LiteralPath $zip -DestinationPath $work
	$launcher = Join-Path $work 'lookstow\lookstow.exe'
	if (-not (Test-Path -LiteralPath $launcher)) { Fail "$Asset has no lookstow.exe" }

	$arguments = @('install', '--prefix', $Prefix, '--data-dir', $DataDir)
	if ($Port -ne 0) { $arguments += @('--port', "$Port") }
	if ($NoService) { $arguments += '--no-service' }
	& $launcher @arguments
	if ($LASTEXITCODE -ne 0) { Fail "lookstow install failed (exit $LASTEXITCODE)" }
} finally {
	Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

if ($NoService) { return }

$listenPort = 8030
foreach ($line in Get-Content -LiteralPath (Join-Path $DataDir 'server.env')) {
	if ($line -match '^\s*PORT\s*=\s*(\d+)\s*$') { $listenPort = [int]$Matches[1] }
}
$log = Join-Path $DataDir 'server.log'

# Waits for GET /readyz on this computer: the database is open and migrated.
Say 'Waiting for Lookstow to start...'
$ready = $false
for ($try = 0; $try -lt 90 -and -not $ready; $try++) {
	& curl.exe -fs --max-time 2 "http://127.0.0.1:$listenPort/readyz" 2>$null | Out-Null
	if ($LASTEXITCODE -eq 0) { $ready = $true } else { Start-Sleep -Seconds 1 }
}
if (-not $ready) { Fail "Lookstow did not become ready on port $listenPort; see $log" }

Write-Host ''
Write-Host 'Lookstow is running.'
Write-Host ''
Write-Host "  Open:        http://127.0.0.1:$listenPort"
Write-Host ''
Write-Host '  The console answers on this computer only.'
Write-Host '  Updates:     automatic and signed; the console''s Updates page has Update now.'
Write-Host "  Status:      & '$Prefix\current\lookstow.exe' status"
Write-Host "  Log:         $log"
Write-Host "  Uninstall:   & '$Prefix\current\lookstow.exe' uninstall  (add --purge to delete the data)"
