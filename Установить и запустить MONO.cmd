@echo off
rem MONO - setup from source for Windows 10/11, in a small window without a console.
rem Double-click: checks Node.js, Python and FFmpeg (installs them with winget if
rem missing), verifies the app, puts a "MONO Transcribe" icon on the Desktop and starts MONO.
rem This file is ASCII on purpose: cmd.exe reads it in the OEM code page.
cd /d "%~dp0"
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\install\windows.ps1" -Gui %*
exit /b 0
