@echo off
REM Starts the agent. Any arguments are passed straight through, e.g.
REM   run.bat --mode test --part 1
setlocal
cd /d "%~dp0"
if exist .venv\Scripts\activate.bat call .venv\Scripts\activate.bat
python src\main.py %*
