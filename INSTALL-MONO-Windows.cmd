@echo off
rem MONO Transcribe - one-click setup for Windows 10/11.
rem Double-click: checks Node.js, Python and FFmpeg (installs them with winget if
rem missing), verifies the app, and puts a "MONO Transcribe" shortcut on the Desktop.
rem This file is ASCII on purpose: cmd.exe reads it in the OEM code page.
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install\windows.ps1" %*
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo Setup did not finish. See the messages above. Press any key to close.
  pause >nul
)
exit /b %CODE%
