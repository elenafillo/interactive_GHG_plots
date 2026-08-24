@echo off
REM Double-click this to run the footprint explorer.
REM
REM explore.html cannot be opened straight from the filesystem: browsers refuse
REM ES modules and fetch() over file://, so the page never starts. This serves
REM web/ over HTTP and opens it.

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on PATH, and this launcher needs it.
  echo   Either install Node, or serve the folder with Python instead:
  echo.
  echo     python -m http.server 8765 --directory web
  echo.
  echo   then open http://localhost:8765/explore.html
  echo.
  pause
  exit /b 1
)

node "%~dp0scripts\serve.mjs" %*

REM Keep the window open so any error stays readable after a double-click.
pause
