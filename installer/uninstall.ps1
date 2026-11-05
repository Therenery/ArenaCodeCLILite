#Requires -Version 5.1
<#
  Arena 卸载脚本

  停掉正在跑的 arena-lite 与桥进程，删快捷方式，从用户 PATH 移除，
  清掉安装目录。登录态和会话记录（%USERPROFILE%\.arena-bridge）默认保留，
  加 -Purge 一并删掉。

  用法：
    uninstall.cmd
    powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Purge
#>
param(
  [string]$Dir = '',
  [switch]$Purge
)

$ErrorActionPreference = 'Continue'

function Ok($m)   { Write-Host "  [OK] $m"   -ForegroundColor Green }
function Warn($m) { Write-Host "  [!]  $m"   -ForegroundColor Yellow }

Write-Host ''
Write-Host '  Arena 卸载程序' -ForegroundColor Cyan
Write-Host '  ----------------------------------------'
Write-Host ''

if (-not $Dir) { $Dir = Join-Path $env:LOCALAPPDATA 'Programs\Arena' }
$Dir = [IO.Path]::GetFullPath($Dir)

# ---------------------------------------------------------------- 1. 停进程
$killed = 0
Get-Process arena-lite -ErrorAction SilentlyContinue | ForEach-Object {
  Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  $killed++
}
# 只杀从安装目录起的那个桥，别误伤别处跑的
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -and
    $_.CommandLine.IndexOf($Dir, [StringComparison]::OrdinalIgnoreCase) -ge 0
  } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    $killed++
  }
if ($killed) { Ok "停掉 $killed 个进程" }

# ---------------------------------------------------------------- 2. 快捷方式
$desktop = [Environment]::GetFolderPath('Desktop')
if ($desktop) {
  $p = Join-Path $desktop 'Arena.lnk'
  if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force; Ok '删掉桌面快捷方式' }
}
$sm = Join-Path ([Environment]::GetFolderPath('Programs')) 'Arena'
if (Test-Path -LiteralPath $sm) { Remove-Item -LiteralPath $sm -Recurse -Force; Ok '删掉开始菜单项' }

# ---------------------------------------------------------------- 3. PATH
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath) {
  $parts = @($userPath -split ';' | Where-Object {
    $_ -ne '' -and $_.TrimEnd('\').ToLower() -ne $Dir.TrimEnd('\').ToLower()
  })
  [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
  Ok '从用户 PATH 移除'
}

# ---------------------------------------------------------------- 4. 环境变量
[Environment]::SetEnvironmentVariable('ARB_RESTORE_CMD', $null, 'User')
Ok '清掉 ARB_RESTORE_CMD'

# ---------------------------------------------------------------- 5. 目录
if (Test-Path -LiteralPath $Dir) {
  Remove-Item -LiteralPath $Dir -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $Dir) { Warn "没删干净，手动删一下：$Dir" }
  else { Ok "删掉 $Dir" }
}

# ---------------------------------------------------------------- 6. 数据
$data = Join-Path $env:USERPROFILE '.arena-bridge'
if ($Purge) {
  if (Test-Path -LiteralPath $data) {
    Remove-Item -LiteralPath $data -Recurse -Force -ErrorAction SilentlyContinue
    Ok '删掉登录态与会话记录'
  }
} elseif (Test-Path -LiteralPath $data) {
  Warn "登录态留在 $data（想一起删就加 -Purge）"
}

Write-Host ''
Write-Host '  卸载完成。' -ForegroundColor Green
Write-Host ''
