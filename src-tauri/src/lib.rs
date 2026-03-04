use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChapterInfo {
    pub title: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BookInfo {
    pub title: String,
    pub content: String,
    pub chapters: Vec<ChapterInfo>,
}

fn detect_chapters(content: &str) -> Vec<ChapterInfo> {
    let mut chapters: Vec<ChapterInfo> = Vec::new();
    let mut seen_titles: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Match Chinese chapter headings and common English chapter titles.
    let re = regex::Regex::new(
        r"(?m)^\s*((?:第\s*[0-9一二三四五六七八九十百千万零两〇]+\s*[章节卷部篇回集])|(?:序章|楔子|后记|番外|尾声|引子)|(?:Chapter\s+\d+)|(?:CHAPTER\s+\d+))\s*(.*)$",
    )
    .unwrap();

    for cap in re.captures_iter(content) {
        if let (Some(chapter_num), Some(chapter_name)) = (cap.get(1), cap.get(2)) {
            let num = chapter_num.as_str().trim();
            let name = chapter_name.as_str().trim();
            let title = if name.is_empty() {
                num.to_string()
            } else {
                format!("{} {}", num, name)
            };

            let start = chapter_num.start();

            if title.len() > 80 || title.len() < 2 {
                continue;
            }

            if seen_titles.contains(&title) {
                continue;
            }
            seen_titles.insert(title.clone());

            chapters.push(ChapterInfo {
                title,
                start,
                end: 0,
            });
        }
    }

    chapters.sort_by_key(|c| c.start);

    let len = chapters.len();
    for i in 0..len {
        chapters[i].end = if i + 1 < len {
            chapters[i + 1].start
        } else {
            content.len()
        };
    }

    chapters
}

#[tauri::command]
fn read_txt_file(path: String, encoding: Option<String>) -> Result<BookInfo, String> {
    let enc = encoding.unwrap_or_else(|| "utf-8".to_string());

    let bytes = fs::read(&path).map_err(|e| e.to_string())?;

    let content = match enc.as_str() {
        "gbk" | "gb2312" | "gb18030" => {
            let mut conv = encoding_rs::GBK;
            let (result, _, had_errors) = conv.decode(&bytes);
            if had_errors {
                String::from_utf8_lossy(&bytes).to_string()
            } else {
                result.to_string()
            }
        }
        "big5" => {
            let mut conv = encoding_rs::BIG5;
            let (result, _, had_errors) = conv.decode(&bytes);
            if had_errors {
                String::from_utf8_lossy(&bytes).to_string()
            } else {
                result.to_string()
            }
        }
        _ => String::from_utf8_lossy(&bytes).to_string(),
    };

    let title = PathBuf::from(&path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown")
        .to_string();

    let chapters = detect_chapters(&content);

    Ok(BookInfo {
        title,
        content,
        chapters,
    })
}

#[tauri::command]
fn read_epub_file(_path: String) -> Result<BookInfo, String> {
    Err("EPUB support coming soon".to_string())
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn show_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn toggle_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

#[tauri::command]
fn minimize_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.minimize();
    }
}

#[tauri::command]
fn close_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.close();
    }
}

#[tauri::command]
fn set_window_opacity(_app: AppHandle, _opacity: f64) {}

fn setup_tray<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    let show_i = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let hide_i = MenuItem::with_id(app, "hide", "Hide", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show_i, &hide_i, &quit_i])?;

    let icon = match app.default_window_icon() {
        Some(icon) => icon.clone(),
        None => {
            return Err("No default window icon".into());
        }
    };

    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("NovelReader")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            if let Err(e) = setup_tray(app.handle()) {
                eprintln!("Failed to setup tray: {}", e);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_txt_file,
            read_epub_file,
            hide_window,
            show_window,
            toggle_window,
            minimize_window,
            close_window,
            set_window_opacity,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
