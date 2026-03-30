$ErrorActionPreference = "Stop"

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
  Write-Host "Requesting administrator privileges..."
  $scriptPath = $MyInvocation.MyCommand.Path
  Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", ('"{0}"' -f $scriptPath)
  )
  exit
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serviceDir = Join-Path $scriptDir "services\\mineru_service"
$logDir = Join-Path $serviceDir "logs"
$logFile = Join-Path $logDir "uvicorn.log"

if (-not (Test-Path (Join-Path $serviceDir "app.py"))) {
  Write-Error "Could not find MinerU service app at '$serviceDir\\app.py'."
  exit 1
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$pythonExe = $null
if (Test-Path (Join-Path $serviceDir ".venv\\Scripts\\python.exe")) {
  $pythonExe = Join-Path $serviceDir ".venv\\Scripts\\python.exe"
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
  $pythonExe = "py"
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
  $pythonExe = "python"
}

if (-not $pythonExe) {
  Write-Error "Neither .venv\\Scripts\\python.exe, py, nor python was found on PATH."
  exit 1
}

Write-Host "Starting FastAPI MinerU service..."
Write-Host "Service dir: $serviceDir"
Write-Host "Log file: $logFile"

Push-Location $serviceDir
try {
  # Route stderr through cmd.exe so uvicorn's normal startup logs are treated as text,
  # not as PowerShell NativeCommandError records.
  $quotedPython = '"' + $pythonExe + '"'
  $commandLine = "$quotedPython -m uvicorn app:app --host 0.0.0.0 --port 8000 2>&1"
  cmd.exe /c $commandLine | Tee-Object -FilePath $logFile -Append
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
