@echo off
REM ============================================================
REM  StopTrack server — double-click to start (Windows)
REM
REM  No token to set up: the server makes its own unique token
REM  the first time and prints it. Keep this window open, then
REM  read the "Auth token" and "Address" lines it shows and
REM  enter them on each phone / watch / browser.
REM
REM  OPTIONAL: after you set up a tunnel (SETUP.md Part B), put
REM  your https address on the line below so it's printed too:
REM     set PUBLIC_URL=https://stoptrack.yourdomain.com
REM ============================================================

set PUBLIC_URL=

cd /d "%~dp0"
echo Starting StopTrack server... (close this window to stop it)
node server.js
pause
