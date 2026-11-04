//! 配色。256 色够用，全部走 SGR，Windows 上一旦开了 VT 处理就能显示。
//!
//! 想关颜色：`--no-color` 或环境变量 `NO_COLOR=1`。

use crate::mode::Mode;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Palette {
    /// 用户输入：白/亮灰
    User,
    /// 助手正文：默认前景
    Assistant,
    /// 思考内容：暗灰 240
    Reasoning,
    /// 工具调用：青 37
    Tool,
    /// 系统提示：蓝 33
    System,
    /// 错误：红 196
    Error,
    /// 次要信息（提示行、时间戳）
    Dim,
    /// 成功/健康
    Good,
    /// 警告
    Warn,
    /// 强调（会话名、模型）
    Accent,
}

impl Palette {
    fn code(self) -> &'static str {
        match self {
            Palette::User => "97",
            Palette::Assistant => "39",
            Palette::Reasoning => "38;5;240",
            Palette::Tool => "38;5;37",
            Palette::System => "38;5;33",
            Palette::Error => "38;5;196",
            Palette::Dim => "38;5;244",
            Palette::Good => "38;5;42",
            Palette::Warn => "38;5;220",
            Palette::Accent => "38;5;81",
        }
    }
}

/// 模式颜色：agent 青、direct 蓝、battle 品红、side 黄
pub fn mode_code(mode: Mode) -> &'static str {
    match mode {
        Mode::Agent => "38;5;44",   // 青
        Mode::Direct => "38;5;39",  // 蓝
        Mode::Battle => "38;5;199", // 品红
        Mode::Side => "38;5;220",   // 黄
    }
}

pub struct Theme {
    pub enabled: bool,
}

impl Theme {
    pub fn new(enabled: bool) -> Theme {
        Theme { enabled }
    }

    /// 按调色板上色
    pub fn paint(&self, s: &str, p: Palette) -> String {
        if !self.enabled || s.is_empty() {
            return s.to_string();
        }
        format!("\x1b[{}m{}\x1b[0m", p.code(), s)
    }

    /// 按调色板上色 + 加粗
    pub fn paint_bold(&self, s: &str, p: Palette) -> String {
        if !self.enabled || s.is_empty() {
            return s.to_string();
        }
        format!("\x1b[1;{}m{}\x1b[0m", p.code(), s)
    }

    /// 模式标签（带颜色、加粗）
    pub fn mode_tag(&self, mode: Mode, text: &str) -> String {
        if !self.enabled {
            return text.to_string();
        }
        format!("\x1b[1;{}m{}\x1b[0m", mode_code(mode), text)
    }

    /// 直接给一个 SGR 参数（例如反显光标）
    pub fn raw(&self, sgr: &str, text: &str) -> String {
        if !self.enabled || text.is_empty() {
            return text.to_string();
        }
        format!("\x1b[{}m{}\x1b[0m", sgr, text)
    }

    pub fn dim(&self, s: &str) -> String {
        self.paint(s, Palette::Dim)
    }
}

/* ---------- 屏幕控制（不依赖平台，Windows 上靠 VT 处理） ---------- */

pub const ALT_SCREEN_ON: &str = "\x1b[?1049h";
pub const ALT_SCREEN_OFF: &str = "\x1b[?1049l";
pub const CURSOR_HIDE: &str = "\x1b[?25l";
pub const CURSOR_SHOW: &str = "\x1b[?25h";
pub const CLEAR_SCREEN: &str = "\x1b[2J";
pub const CLEAR_LINE: &str = "\x1b[2K";

/// 光标定位（1 基）
pub fn goto(row: u16, col: u16) -> String {
    format!("\x1b[{};{}H", row, col)
}

pub fn bell() -> &'static str {
    "\x07"
}

/* ---------- 彩色 LOGO ---------- */

/// 6 行 LOGO，ANSI Shadow 字形，整块笔画，宽 46 列
pub const LOGO_LINES: [&str; 6] = [
    r" █████╗  ██████╗  ███████╗ ███╗   ██╗  █████╗ ",
    r"██╔══██╗ ██╔══██╗ ██╔════╝ ████╗  ██║ ██╔══██╗",
    r"███████║ ██████╔╝ █████╗   ██╔██╗ ██║ ███████║",
    r"██╔══██║ ██╔══██╗ ██╔══╝   ██║╚██╗██║ ██╔══██║",
    r"██║  ██║ ██║  ██║ ███████╗ ██║ ╚████║ ██║  ██║",
    r"╚═╝  ╚═╝ ╚═╝  ╚═╝ ╚══════╝ ╚═╝  ╚═══╝ ╚═╝  ╚═╝",
];

/// 两级着色：主体青蓝 45，最底一行阴影压暗到 31
pub fn logo_ansi(theme: &Theme) -> Vec<String> {
    if !theme.enabled {
        return LOGO_LINES.iter().map(|s| s.to_string()).collect();
    }
    let last = LOGO_LINES.len() - 1;
    LOGO_LINES
        .iter()
        .enumerate()
        .map(|(i, line)| {
            let code = if i == last { "38;5;31" } else { "38;5;45" };
            format!("\x1b[{}m{}\x1b[0m", code, line)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paint_respects_flag() {
        let on = Theme::new(true);
        let off = Theme::new(false);
        assert!(on.paint("x", Palette::Tool).contains("\x1b["));
        assert_eq!(off.paint("x", Palette::Tool), "x");
        assert_eq!(off.mode_tag(Mode::Battle, "battle"), "battle");
        assert!(on.mode_tag(Mode::Battle, "battle").contains("199"));
    }

    #[test]
    fn mode_colors_are_distinct() {
        let mut codes = Vec::new();
        for m in Mode::all() {
            codes.push(mode_code(m));
        }
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), 4);
    }

    #[test]
    fn logo_has_expected_shape() {
        assert_eq!(LOGO_LINES.len(), 6);
        let plain = logo_ansi(&Theme::new(false));
        assert_eq!(plain.len(), 6);
        assert!(plain[0].contains("ARENA") || plain[0].contains('█'));
        let colored = logo_ansi(&Theme::new(true));
        assert!(colored[0].contains("\x1b[38;5;"));
    }

    #[test]
    fn goto_and_clear() {
        assert_eq!(goto(1, 1), "\x1b[1;1H");
        assert_eq!(bell(), "\x07");
    }
}
