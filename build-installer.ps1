#Requires -Version 5.1
<#
  打安装包

  把 arena-lite.exe 塞进 installer\ 的内容里，打成 dist\arena-setup-<版本>.zip。
  这个 zip 就是发给用户的那个：解压 → 双击 install.cmd。

  用法：
    powershell -ExecutionPolicy Bypass -File build-installer.ps1
    powershell ... -File build-installer.ps1 -Exe D:\somewhere\arena-lite.exe
#>
param(
  [string]$Exe = '',
  [string]$Out = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$inst = Join-Path $root 'installer'
if (-not (Test-Path -LiteralPath $inst)) { throw "缺 installer 目录：$inst" }

if (-not $Exe) {
  foreach ($p in @(
    (Join-Path $root 'arena-lite\target\release\arena-lite.exe'),
    (Join-Path $root 'arena-lite\target\x86_64-pc-windows-gnu\release\arena-lite.exe')
  )) {
    if (Test-Path -LiteralPath $p) { $Exe = $p; break }
  }
}
if (-not $Exe) { throw '找不到 arena-lite.exe。先编一个，或者用 -Exe 指定路径。' }
if (-not (Test-Path -LiteralPath $Exe)) { throw "exe 不存在：$Exe" }

$ver = (Get-Content -LiteralPath (Join-Path $inst 'VERSION') -Raw).Trim()
if (-not $Out) { $Out = Join-Path $root "dist\arena-setup-$ver.zip" }

# 先在临时目录拼好再压，免得把仓库里的杂项也打进去
$tmp = Join-Path $env:TEMP ('arena-pkg-' + [guid]::NewGuid().ToString('n').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
  Copy-Item -Path (Join-Path $inst '*') -Destination $tmp -Recurse -Force
  Copy-Item -LiteralPath $Exe -Destination (Join-Path $tmp 'arena-lite.exe') -Force

  $outDir = Split-Path -Parent $Out
  if ($outDir) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
  if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force }

  Compress-Archive -Path (Join-Path $tmp '*') -DestinationPath $Out -CompressionLevel Optimal

  $size = (Get-Item -LiteralPath $Out).Length
  Write-Host ("打包完成：{0}（{1} KB）" -f $Out, [math]::Round($size / 1KB))
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
