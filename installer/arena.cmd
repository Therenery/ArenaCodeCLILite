@echo off
rem arena -- 启动 arena-lite 终端客户端。
rem 不要在这里 chcp：输入代码页必须保持系统默认（936），否则中文输入法失效。
title Arena
setlocal

set "ARENA_HOME=%~dp0"
set "ARENA_URL=http://127.0.0.1:17892"

rem 桥没在跑就先拉一个，窗口最小化，日志写到安装目录
curl.exe -s -m 2 %ARENA_URL%/health >nul 2>&1
if errorlevel 1 (
  start "arena-bridge" /min "%ARENA_HOME%bridge\launch.cmd"
  timeout /t 3 /nobreak >nul
)

if not exist "%ARENA_HOME%arena-lite.exe" (
  echo arena-lite.exe 不见了，重新装一次：install.cmd
  exit /b 1
)

"%ARENA_HOME%arena-lite.exe" %*
