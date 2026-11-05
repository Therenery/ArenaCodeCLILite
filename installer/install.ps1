#Requires -Version 5.1
<#
  Arena 安装脚本

  把 arena-lite 和 arena-bridge 装进 %LOCALAPPDATA%\Programs\Arena，
  加进用户 PATH，建桌面与开始菜单快捷方式。
  全部在用户目录内，不需要管理员权限，不写注册表 Run 键，不起服务。

  用法：
    install.cmd                       # 双击
    powershell -ExecutionPolicy Bypass -File install.ps1
    powershell ... -File install.ps1 -Dir D:\Arena
#>
param(
  [string]$Dir = '',
  [switch]$NoShortcut
)

$ErrorActionPreference = 'Stop'

function Say($m)  { Write-Host "  $m" }
function Ok($m)   { Write-Host "  [OK] $m"   -ForegroundColor Green }
function Warn($m) { Write-Host "  [!]  $m"   -ForegroundColor Yellow }
function Die($m)  { Write-Host "  [X]  $m"   -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host '  Arena 安装程序' -ForegroundColor Cyan
Write-Host '  ----------------------------------------'
Write-Host ''

$src = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Dir) { $Dir = Join-Path $env:LOCALAPPDATA 'Programs\Arena' }
$Dir = [IO.Path]::GetFullPath($Dir)

# ---------------------------------------------------------------- 1. node
$node = $null
$cands = @()
$c = Get-Command node -ErrorAction SilentlyContinue
if ($c) { $cands += $c.Source }
$cands += @(
  (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
)
foreach ($p in $cands) {
  if ($p -and (Test-Path -LiteralPath $p)) { $node = $p; break }
}
if (-not $node) {
  Die @'
没找到 Node.js。桥是一段 node 程序，没有它跑不起来。

  装一个：https://nodejs.org/  （选 LTS，一路下一步）
  装完关掉这个窗口重新双击 install.cmd
'@
}
$verText = (& $node -v 2>$null)
if ($verText -notmatch '^v(\d+)\.') { Die "node 版本读不出来：$verText" }
$major = [int]$Matches[1]
if ($major -lt 21) { Die "node 版本太旧（$verText），至少要 21。请到 nodejs.org 装新版。" }
Ok "node $verText"

# ---------------------------------------------------------------- 2. 浏览器
$browser = $null
$bcands = @(
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
)
foreach ($p in $bcands) {
  if ($p -and (Test-Path -LiteralPath $p)) { $browser = $p; break }
}
if ($browser) { Ok ("浏览器 " + (Split-Path -Leaf $browser)) }
else { Warn '没找到 Chrome / Edge。桥运行时需要，装好后再启动 arena 就行。' }

# ---------------------------------------------------------------- 3. 复制文件
if (Test-Path -LiteralPath $Dir) {
  $alive = Get-Process arena-lite -ErrorAction SilentlyContinue
  if ($alive) { Die "Arena 正在运行（pid $($alive[0].Id)），先关掉它再装。" }
}
New-Item -ItemType Directory -Path $Dir -Force | Out-Null

if ($src.TrimEnd('\').ToLower() -eq $Dir.TrimEnd('\').ToLower()) {
  Ok '已经解压在安装目录里，跳过复制'
} else {
  foreach ($f in @('arena-lite.exe', 'arena.cmd', 'VERSION', 'README.md',
                   'install.cmd', 'install.ps1', 'uninstall.cmd', 'uninstall.ps1')) {
    $s = Join-Path $src $f
    if (Test-Path -LiteralPath $s) { Copy-Item -LiteralPath $s -Destination $Dir -Force }
  }
  foreach ($d in @('bridge', 'scripts')) {
    $s = Join-Path $src $d
    if (Test-Path -LiteralPath $s) {
      Copy-Item -LiteralPath $s -Destination $Dir -Recurse -Force
    }
  }
  Ok "文件装到 $Dir"
}

# ---------------------------------------------------------------- 4. PATH
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
$parts = @($userPath -split ';' | Where-Object { $_ -ne '' })
$lower = $parts | ForEach-Object { $_.TrimEnd('\').ToLower() }
if ($lower -notcontains $Dir.TrimEnd('\').ToLower()) {
  $newPath = (@($parts) + $Dir) -join ';'
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Ok '已加入用户 PATH'
} else {
  Ok 'PATH 里已有，跳过'
}
# 当前这个进程也要能立刻用到
$env:Path = "$Dir;$env:Path"

# ---------------------------------------------------------------- 5. 环境变量
$restore = Join-Path $Dir 'scripts\restore-chrome.ps1'
$restoreCmd = 'powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $restore + '"'
[Environment]::SetEnvironmentVariable('ARB_RESTORE_CMD', $restoreCmd, 'User')
$env:ARB_RESTORE_CMD = $restoreCmd
Ok 'ARB_RESTORE_CMD 已设置（撞上人机验证时把浏览器拉到前台）'

# ---------------------------------------------------------------- 6. 快捷方式
if (-not $NoShortcut) {
  $ws = New-Object -ComObject WScript.Shell
  $exe = Join-Path $Dir 'arena-lite.exe'
  $cmd = Join-Path $Dir 'arena.cmd'

  $desktop = [Environment]::GetFolderPath('Desktop')
  if ($desktop) {
    $l = $ws.CreateShortcut((Join-Path $desktop 'Arena.lnk'))
    $l.TargetPath = $cmd
    $l.WorkingDirectory = $Dir
    $l.IconLocation = "$exe,0"
    $l.Description = 'Arena 终端客户端'
    $l.Save()
  }

  $sm = Join-Path ([Environment]::GetFolderPath('Programs')) 'Arena'
  New-Item -ItemType Directory -Path $sm -Force | Out-Null

  $l = $ws.CreateShortcut((Join-Path $sm 'Arena.lnk'))
  $l.TargetPath = $cmd
  $l.WorkingDirectory = $Dir
  $l.IconLocation = "$exe,0"
  $l.Description = 'Arena 终端客户端'
  $l.Save()

  $un = Join-Path $Dir 'uninstall.cmd'
  if (Test-Path -LiteralPath $un) {
    $l = $ws.CreateShortcut((Join-Path $sm '卸载 Arena.lnk'))
    $l.TargetPath = $un
    $l.WorkingDirectory = $Dir
    $l.IconLocation = "$exe,0"
    $l.Save()
  }
  Ok '桌面与开始菜单快捷方式已建'
}

# ---------------------------------------------------------------- 7. 收尾
$v = 'unknown'
$vf = Join-Path $Dir 'VERSION'
if (Test-Path -LiteralPath $vf) { $v = (Get-Content -LiteralPath $vf -Raw).Trim() }

Write-Host ''
Write-Host '  ----------------------------------------'
Write-Host "  装好了：Arena $v" -ForegroundColor Green
Write-Host ''
Write-Host '  开始用：'
Write-Host '    双击桌面上的 Arena，或在任意终端敲  arena'
Write-Host ''
Write-Host '  第一次启动会自己拉起 Chrome 和桥，稍等几秒。'
Write-Host "  数据（登录态、会话地址）在 $env:USERPROFILE\.arena-bridge"
Write-Host '  卸载：开始菜单 > Arena > 卸载 Arena'
Write-Host ''
