@echo off
rem Arena 安装程序入口。双击即可，不需要管理员权限。
setlocal
title Arena Setup
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
