@echo off
rem Start the local document-worker (local storage mode) for the desktop app.
rem Polls the shared jobs.db and indexes uploaded PDFs into the local stores
rem rag-service reads. Used in development only - packaged builds ship a
rem PyInstaller sidecar.
setlocal

set "ROOT=%~dp0..\..\.."
set "WORKER_DIR=%ROOT%\apps\document-worker"
set "VENV_PY=%WORKER_DIR%\.venv\Scripts\python.exe"

if not "%RAG_WORKER%"=="" (
  %RAG_WORKER%
  exit /b %errorlevel%
)

if not exist "%VENV_PY%" (
  echo document-worker venv not found at %VENV_PY% 1>&2
  exit /b 1
)

set "STORAGE_MODE=local"
if "%LOCAL_DATA_DIR%"=="" set "LOCAL_DATA_DIR=%ROOT%\data\desktop"
if not exist "%LOCAL_DATA_DIR%" mkdir "%LOCAL_DATA_DIR%"
if "%PYTHONPATH%"=="" (set "PYTHONPATH=%WORKER_DIR%") else (set "PYTHONPATH=%WORKER_DIR%;%PYTHONPATH%")

"%VENV_PY%" -m src.main
exit /b %errorlevel%
