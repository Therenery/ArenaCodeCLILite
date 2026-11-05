@echo off
rem 桥的启动器：由 arena.cmd 用 start /min 拉起，日志写到安装目录下的 bridge.log。
rem 单独跑也行，用来排查桥起不来的问题。
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo 没找到 node，装一个：https://nodejs.org/
  pause
  exit /b 1
)

node "%~dp0arena_bridge.js" >> "%~dp0bridge.log" 2>&1
