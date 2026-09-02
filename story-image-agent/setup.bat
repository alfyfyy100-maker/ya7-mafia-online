@echo off
REM One-time setup on Windows: virtual environment + dependencies + Chromium.
setlocal
cd /d "%~dp0"

python -m venv .venv || goto :error
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt || goto :error

REM Playwright needs a browser build. If you prefer your own Chrome, skip this
REM and set "browser": { "channel": "chrome" } in config\config.json (default).
python -m playwright install chromium || goto :error

echo.
echo Setup finished. Put your story in input\story.txt, then run: run.bat
goto :eof

:error
echo.
echo Setup failed. See the messages above.
exit /b 1
