@echo off
REM ============================================================
REM  StopTrack server — double-click to start (Windows)
REM
REM  1) EDIT THE TOKEN BELOW once (make it long and random —
REM     it is the password every device uses).
REM  2) Double-click this file. Keep the window open.
REM
REM  The server address is then:  http://<this-PC's-IP>:4000
REM ============================================================

set FACTORY_TOKEN=change-me-to-a-long-random-secret

cd /d "%~dp0"
echo Starting StopTrack server... (close this window to stop it)
node server.js
pause
