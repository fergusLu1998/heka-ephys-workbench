@echo off
if exist "%~dp0.venv\Scripts\python.exe" (
  "%~dp0.venv\Scripts\python.exe" "%~dp0launch_platform.py"
) else (
  py -3 "%~dp0launch_platform.py"
)
if errorlevel 1 pause
