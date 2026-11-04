@echo off
chcp 65001 >nul
if not defined ARENA_CHROME  set "ARENA_CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined ARENA_PROFILE set "ARENA_PROFILE=%USERPROFILE%\.arena-bridge\chrome-profile"
if not exist "%ARENA_PROFILE%" mkdir "%ARENA_PROFILE%"
start "" "%ARENA_CHROME%" --remote-debugging-port=9222 --user-data-dir="%ARENA_PROFILE%" --no-first-run --no-default-browser-check
