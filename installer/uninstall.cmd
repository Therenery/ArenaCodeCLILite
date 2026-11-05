@echo off
rem Arena 卸载程序入口。
setlocal
title Arena Uninstall
echo.
echo   即将卸载 Arena。
echo.
echo   会停掉正在运行的 arena 和桥，删掉程序文件与快捷方式。
echo   登录态和会话记录默认保留。
echo.
set /p YN="  继续？(y/N) "
if /i not "%YN%"=="y" (
  echo   已取消。
  timeout /t 2 >nul
  exit /b 0
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
echo.
pause
