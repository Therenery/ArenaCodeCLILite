# 把 arena 用的浏览器窗口从最小化/后台拉回前台，给过验证码的人看。
#
# 由桥在撞上人机验证时触发：桥调 ARB_RESTORE_CMD，安装程序把它设成
#   powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File <本文件>
# 桥和浏览器在同一个用户会话里，所以这里直接抢前台就行，不需要计划任务。

$all = Get-Process chrome, msedge -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 }

# 优先挑 arena 那个窗口，别把用户自己开的浏览器拽出来
$p = $all | Where-Object { $_.MainWindowTitle -match 'arena' } | Select-Object -First 1
if (-not $p) { $p = $all | Select-Object -First 1 }
if (-not $p) { exit }

Add-Type -Name W -Namespace N -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
'@

$h = $p.MainWindowHandle
if ([N.W]::IsIconic($h)) { [N.W]::ShowWindow($h, 9) | Out-Null }   # 9 = SW_RESTORE

# Windows 默认不让后台进程抢焦点，临时挂到当前前台线程上才抢得到
$fg = [N.W]::GetForegroundWindow()
$ft = [N.W]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
$ct = [N.W]::GetCurrentThreadId()
[N.W]::AttachThreadInput($ct, $ft, $true)  | Out-Null
[N.W]::BringWindowToTop($h)                | Out-Null
[N.W]::SetForegroundWindow($h)             | Out-Null
[N.W]::AttachThreadInput($ct, $ft, $false) | Out-Null
