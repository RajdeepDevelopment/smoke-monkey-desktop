@echo off
rem Start the local rag-service backend (local storage mode) for the desktop app.
rem Used in development only - packaged builds ship a PyInstaller sidecar.
setlocal

set "ROOT=%~dp0..\..\.."
set "RAG_DIR=%ROOT%\apps\rag-service"
set "VENV_PY=%RAG_DIR%\.venv\Scripts\python.exe"

rem Uncommon port so the desktop backend never collides with the cloud
rem gateway / web stack (docker or local, typically :8000).
if "%RAG_SERVICE_PORT%"=="" set "RAG_SERVICE_PORT=8642"

rem Simple health probe via PowerShell
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 'http://127.0.0.1:%RAG_SERVICE_PORT%/api/health').StatusCode } catch { 'down' }" > nul 2>&1
if not errorlevel 1 goto already_running

if not "%RAG_BACKEND%"=="" (
  %RAG_BACKEND%
  exit /b %errorlevel%
)

if not exist "%VENV_PY%" (
  echo rag-service venv not found at %VENV_PY% 1>&2
  exit /b 1
)

set "STORAGE_MODE=local"
if "%LOCAL_DATA_DIR%"=="" set "LOCAL_DATA_DIR=%ROOT%\data\desktop"
if not exist "%LOCAL_DATA_DIR%" mkdir "%LOCAL_DATA_DIR%"

rem Desktop ships with free mode and web search on. The "free" gateway is the
rem rag-service itself (served at /v1 on this same port), so no separate
rem OmniRoute install is needed - it proxies to free models using the user's
rem saved BYOK key.
set "OMNIROUTE_ENABLED=true"
set "OMNIROUTE_BASE_URL=http://127.0.0.1:%RAG_SERVICE_PORT%/v1"
set "OMNIROUTE_CHAT_MODELS=["auto", "big-pickle", "deepseek-v4-flash-free", "mimo-v2.5-free", "nemotron-3-ultra-free", "laguna-s-2.1-free", "nvidia/nemotron-3-nano-30b-a3b", "nvidia/nemotron-3-super-120b-a12b", "nvidia/nemotron-3-ultra-550b-a55b", "deepseek/deepseek-v4-flash:free", "nvidia/nemotron-3-ultra-550b-a55b:free", "google/gemini-2.0-flash-lite:free", "meta-llama/llama-4-scout-17b-16e:free", "mistralai/mistral-small-3.2:free"]"
set "WEB_SEARCH_ENABLED=true"

"%VENV_PY%" -m uvicorn src.main:app --app-dir "%RAG_DIR%" --host 127.0.0.1 --port %RAG_SERVICE_PORT% --log-level info
exit /b %errorlevel%

:already_running
echo rag-service already running on port %RAG_SERVICE_PORT%
exit /b 0
