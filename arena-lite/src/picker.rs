//! 系统选文件窗口。`/upload` 不带参数时走这里。
//!
//! Windows 用 PowerShell 调 `System.Windows.Forms.OpenFileDialog`；
//! Linux 优先 zenity，其次 kdialog。都没有就返回错误，让调用方提示手打路径。

use std::process::Command;

/// 返回选中的文件；用户取消时返回空列表。
pub fn pick_files() -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        pick_windows()
    }
    #[cfg(not(windows))]
    {
        pick_unix()
    }
}

#[cfg(windows)]
fn pick_windows() -> Result<Vec<String>, String> {
    use std::os::windows::process::CommandExt;

    // PowerShell 的输出编码跟着控制台走，中文路径容易乱；让它把结果写进
    // 一个 UTF-8 临时文件，Rust 这边按 UTF-8 读，绕开代码页。
    let out = std::env::temp_dir().join(format!("arena-pick-{}.txt", std::process::id()));
    let out_ps = out.display().to_string().replace('\'', "''");
    let script = format!(
        "Add-Type -AssemblyName System.Windows.Forms; \
         $d = New-Object System.Windows.Forms.OpenFileDialog; \
         $d.Multiselect = $true; \
         $d.Title = '选择要上传的文件'; \
         if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{ \
           [IO.File]::WriteAllLines('{}', $d.FileNames, (New-Object Text.UTF8Encoding($false))) \
         }}",
        out_ps
    );

    // CREATE_NO_WINDOW：不要闪一个 PowerShell 黑框
    let status = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-STA",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &script,
        ])
        .creation_flags(0x0800_0000)
        .status()
        .map_err(|e| format!("叫不出选文件窗口：{}", e))?;

    let text = std::fs::read_to_string(&out).unwrap_or_default();
    let _ = std::fs::remove_file(&out);

    if !status.success() && text.is_empty() {
        return Err(format!("选文件窗口异常退出（{}）", status.code().unwrap_or(-1)));
    }

    Ok(text
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect())
}

#[cfg(not(windows))]
fn pick_unix() -> Result<Vec<String>, String> {
    if in_path("zenity") {
        let out = Command::new("zenity")
            .args([
                "--file-selection",
                "--multiple",
                "--separator",
                "\n",
                "--title",
                "选择要上传的文件",
            ])
            .output()
            .map_err(|e| format!("叫不出选文件窗口：{}", e))?;
        // zenity 取消时退出码是 1
        if !out.status.success() {
            return Ok(Vec::new());
        }
        return Ok(String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect());
    }
    if in_path("kdialog") {
        let out = Command::new("kdialog")
            .args([
                "--title",
                "选择要上传的文件",
                "--multiple",
                "--separate-output",
                "--getopenfilename",
                ".",
            ])
            .output()
            .map_err(|e| format!("叫不出选文件窗口：{}", e))?;
        if !out.status.success() {
            return Ok(Vec::new());
        }
        return Ok(String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect());
    }
    Err("这个环境没有图形选文件工具（zenity / kdialog），请用 /upload <路径>".to_string())
}

#[cfg(not(windows))]
fn in_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join(name).is_file()))
        .unwrap_or(false)
}
