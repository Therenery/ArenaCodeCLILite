# 把 arena 用的浏览器窗口缩到最小，免得干活时老挡在前面。
#
# 由桥在每轮发送后触发（ARB_MINIMIZE_CMD 为空就不做）。
# 想关掉这个行为，把用户环境变量 ARB_MINIMIZE_CMD 清空即可。

Start-Sleep -Milliseconds 1500

$all = Get-Process chrome, msedge -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 }

$p = $all | Where-Object { $_.MainWindowTitle -match 'arena' } | Select-Object -First 1
if (-not $p) { $p = $all | Select-Object -First 1 }
if (-not $p) { exit }

Add-Type -Name Win -Namespace Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
'@

[Native.Win]::ShowWindow($p.MainWindowHandle, 6) | Out-Null   # 6 = SW_MINIMIZE
