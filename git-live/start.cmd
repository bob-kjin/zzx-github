@echo off
setlocal
cd /d "%~dp0"

if "%~1"=="" (
  node server.js "%~dp0.."
) else (
  node server.js %*
)

pause
