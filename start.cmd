@echo off
rem pushd supports UNC paths (\\wsl.localhost\...) by mapping a temporary drive letter; cd /d does not.
pushd "%~dp0" || (echo Failed to enter project folder: %~dp0 & pause & exit /b 1)
title CS2 Sensitivity Lab - local server
echo Starting local server... the browser will open in a few seconds.
echo.
where node >nul 2>nul
if not errorlevel 1 goto run_node

where python >nul 2>nul
if not errorlevel 1 goto run_python

echo Neither Node.js nor Python was found. Install one of them, then run this file again.
pause
exit /b

:run_node
start "" "http://127.0.0.1:4173"
echo If you see "port busy" below, a server is already running - just open the page.
node "%~dp0serve.js"
echo.
echo Server stopped. Press any key to close this window.
pause >nul
popd
exit /b

:run_python
start "" "http://127.0.0.1:4173"
echo If you see "port busy" below, a server is already running - just open the page.
python -m http.server 4173 --bind 127.0.0.1 --directory "%~dp0"
echo.
echo Server stopped. Press any key to close this window.
pause >nul
popd
exit /b
