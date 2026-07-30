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
REM
REM  OPTIONAL: only if the server sits behind that tunnel (or
REM  another reverse proxy), uncomment the TRUST_PROXY line so
REM  per-device rate limiting sees each device's real address.
REM  Leave it off otherwise — see SETUP.md Part B.
REM ============================================================

set PUBLIC_URL=
REM set TRUST_PROXY=1

cd /d "%~dp0"
echo Starting StopTrack server... (close this window to stop it)

REM Restart if it ever stops. The server is what every phone and watch
REM syncs to: while it is down, stops are logged nowhere and those minutes
REM are gone. So don't leave a dead window sitting there overnight — wait a
REM few seconds (so a genuine problem, like the port being in use, doesn't
REM spin) and start it again. Close this window to stop it for real.
:loop
node server.js
echo.
echo StopTrack server stopped. Restarting in 5 seconds...
echo (Close this window if you meant to stop it.)
timeout /t 5 /nobreak >nul
goto loop
