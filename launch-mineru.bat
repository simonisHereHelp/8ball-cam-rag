@echo off
setlocal

net session >nul 2>nul
if not %errorlevel%==0 (
  echo Requesting administrator privileges...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

set "SCRIPT_DIR=%~dp0"
set "SERVICE_DIR=%SCRIPT_DIR%services\mineru_service"

if not exist "%SERVICE_DIR%\app.py" (
  echo Could not find MinerU service app at "%SERVICE_DIR%\app.py"
  exit /b 1
)

cd /d "%SERVICE_DIR%"

if exist ".venv\Scripts\python.exe" (
  echo Starting MinerU service with .venv\Scripts\python.exe
  ".venv\Scripts\python.exe" -m uvicorn app:app --host 0.0.0.0 --port 8000
  exit /b %errorlevel%
)

where py >nul 2>nul
if %errorlevel%==0 (
  echo Starting MinerU service with py
  py -m uvicorn app:app --host 0.0.0.0 --port 8000
  exit /b %errorlevel%
)

where python >nul 2>nul
if %errorlevel%==0 (
  echo Starting MinerU service with python
  python -m uvicorn app:app --host 0.0.0.0 --port 8000
  exit /b %errorlevel%
)

echo Neither .venv\Scripts\python.exe, py, nor python was found on PATH.
exit /b 1
