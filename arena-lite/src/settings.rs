//! 用户设置：落在 ~/.arena3/config.json，改一次写一次。
//!
//! 这里只放「跟这台机器有关、下次启动还要记住」的偏好；
//! 会话名、模式这类一次性的东西仍然走命令行参数。

use crate::json;
use std::path::PathBuf;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lang {
    Zh,
    En,
}

impl Lang {
    pub fn code(self) -> &'static str {
        match self {
            Lang::Zh => "zh",
            Lang::En => "en",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Lang::Zh => "中文",
            Lang::En => "English",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Settings {
    pub lang: Lang,
    /// 助手正文按 markdown 渲染（粗体、行内代码、标题、列表、代码块）
    pub markdown: bool,
    /// 顺手把 $...$ 里的 LaTeX 换成常见符号
    pub latex: bool,
    /// 启动时思考链默认展开
    pub reasoning_open: bool,
    /// 工具块默认展开（工具阶段正在跑的那个总是展开）
    pub tools_open: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            lang: Lang::Zh,
            markdown: true,
            latex: true,
            reasoning_open: false,
            tools_open: true,
        }
    }
}

/// 配置目录：Windows 用 %USERPROFILE%，其它用 $HOME
pub fn config_path() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".arena3").join("config.json")
}

impl Settings {
    pub fn load() -> Settings {
        let text = match std::fs::read_to_string(config_path()) {
            Ok(t) => t,
            Err(_) => return Settings::default(),
        };
        let v = match json::parse(&text) {
            Ok(v) => v,
            Err(_) => return Settings::default(),
        };
        let mut s = Settings::default();
        if let Some(x) = v.str_at(&["lang"]) {
            s.lang = if x.eq_ignore_ascii_case("en") {
                Lang::En
            } else {
                Lang::Zh
            };
        }
        if let Some(x) = v.bool_at(&["markdown"]) {
            s.markdown = x;
        }
        if let Some(x) = v.bool_at(&["latex"]) {
            s.latex = x;
        }
        if let Some(x) = v.bool_at(&["reasoning_open"]) {
            s.reasoning_open = x;
        }
        if let Some(x) = v.bool_at(&["tools_open"]) {
            s.tools_open = x;
        }
        s
    }

    /// 写回配置文件；失败只返回错误，调用方提示一句就行
    pub fn save(&self) -> std::io::Result<()> {
        let p = config_path();
        if let Some(dir) = p.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let text = format!(
            "{{\n  \"lang\": \"{}\",\n  \"markdown\": {},\n  \"latex\": {},\n  \"reasoning_open\": {},\n  \"tools_open\": {}\n}}\n",
            self.lang.code(),
            self.markdown,
            self.latex,
            self.reasoning_open,
            self.tools_open
        );
        std::fs::write(p, text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_render_markdown_and_tools_open() {
        let s = Settings::default();
        assert!(s.markdown);
        assert!(s.latex);
        assert!(s.tools_open);
        assert!(!s.reasoning_open);
        assert_eq!(s.lang, Lang::Zh);
    }
}
