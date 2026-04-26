use base64::Engine;
use regex::Regex;
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tauri::RunEvent;
use tauri::WindowEvent;
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontmostAppInfo {
    pub bundle_identifier: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SanitizerRuleFlags {
    #[serde(default = "default_true")]
    collapse_inline_spacing: bool,
    #[serde(default = "default_true")]
    collapse_blank_lines: bool,
    #[serde(default = "default_true")]
    remove_trailing_spaces: bool,
    #[serde(default = "default_true")]
    replace_non_breaking_spaces: bool,
    #[serde(default = "default_true")]
    remove_zero_width_spaces: bool,
}

impl Default for SanitizerRuleFlags {
    fn default() -> Self {
        Self {
            collapse_inline_spacing: true,
            collapse_blank_lines: true,
            remove_trailing_spaces: true,
            replace_non_breaking_spaces: true,
            remove_zero_width_spaces: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default = "default_polling_interval_ms")]
    polling_interval_ms: u64,
    #[serde(default)]
    trim_whitespace: bool,
    #[serde(default = "default_true")]
    show_dock_icon: bool,
    #[serde(default = "default_true")]
    show_menu_bar_icon: bool,
    #[serde(default)]
    phrase_filters: Vec<String>,
    #[serde(default = "default_excluded_apps")]
    excluded_apps: Vec<String>,
    #[serde(default)]
    rule_flags: SanitizerRuleFlags,
}

fn default_true() -> bool {
    true
}

fn default_polling_interval_ms() -> u64 {
    250
}

fn default_excluded_apps() -> Vec<String> {
    vec![
        "com.apple.Terminal",
        "com.googlecode.iterm2",
        "com.microsoft.VSCode",
        "com.jetbrains.intellij",
        "com.apple.dt.Xcode",
        "com.apple.Xcode",
        "com.apple.TextEdit",
        "com.apple.Safari",
        "com.apple.ScriptEditor2",
        "com.agilebits.onepassword7",
        "Terminal",
        "iTerm2",
        "Code",
        "Code Helper",
        "Xcode",
        "Script Editor",
        "Safari",
        "Obsidian",
        "Visual Studio Code",
    ]
    .into_iter()
    .map(|value| value.to_string())
    .collect()
}

fn default_settings() -> Settings {
    Settings {
        enabled: true,
        polling_interval_ms: default_polling_interval_ms(),
        trim_whitespace: false,
        show_dock_icon: true,
        show_menu_bar_icon: true,
        phrase_filters: Vec::new(),
        excluded_apps: default_excluded_apps(),
        rule_flags: SanitizerRuleFlags::default(),
    }
}

fn normalize_string_list(entries: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for entry in entries {
        for line in entry.split(|ch| ch == '\n' || ch == '\r') {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let key = trimmed.to_lowercase();
            if seen.insert(key) {
                normalized.push(trimmed.to_string());
            }
        }
    }

    normalized
}

fn normalize_settings(mut settings: Settings) -> Settings {
    settings.polling_interval_ms = settings.polling_interval_ms.max(50);
    settings.phrase_filters = normalize_string_list(settings.phrase_filters);
    settings.excluded_apps = normalize_string_list(settings.excluded_apps);
    if !settings.show_dock_icon && !settings.show_menu_bar_icon {
        settings.show_menu_bar_icon = true;
    }
    settings
}

struct CleanerState {
    settings: Mutex<Settings>,
    // Ensure backend stays in sync even if the webview UI isn't active.
    last_disk_reload: Mutex<Instant>,
    last_raw_signature: Mutex<(i32, usize)>,
    last_written_signature: Mutex<(i32, usize)>,
}

impl CleanerState {
    fn new() -> Self {
        Self {
            settings: Mutex::new(normalize_settings(default_settings())),
            last_disk_reload: Mutex::new(Instant::now() - Duration::from_secs(60)),
            last_raw_signature: Mutex::new((0, 0)),
            last_written_signature: Mutex::new((0, 0)),
        }
    }
}

const SETTINGS_FOLDER: &str = "clipboard-cleaner";
const SETTINGS_FILE: &str = "settings.json";
const LAST_CLEANED_EVENT: &str = "clipboard-cleaner:last-cleaned";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LastCleanedPayload {
    timestamp: String,
}

#[tauri::command]
fn get_frontmost_app() -> FrontmostAppInfo {
    capture_frontmost()
}

#[tauri::command]
fn set_settings(state: tauri::State<'_, Arc<CleanerState>>, settings: Settings) {
    if let Ok(mut guard) = state.settings.lock() {
        *guard = normalize_settings(settings);
    }
}

#[tauri::command]
fn exit_app(handle: AppHandle) {
    handle.exit(0);
}

#[tauri::command]
fn set_dock_icon_visible(visible: bool) {
    set_dock_icon_visible_impl(visible);
}

#[tauri::command]
fn show_main_window(handle: AppHandle, state: tauri::State<'_, Arc<CleanerState>>) {
    let show_dock_icon = state
        .settings
        .lock()
        .map(|guard| guard.show_dock_icon)
        .unwrap_or(true);
    bring_main_window_to_front(&handle, show_dock_icon);
}

#[tauri::command]
fn hide_main_window(handle: AppHandle, state: tauri::State<'_, Arc<CleanerState>>) {
    let show_dock_icon = state
        .settings
        .lock()
        .map(|guard| guard.show_dock_icon)
        .unwrap_or(true);

    let handle_for_call = handle.clone();
    let handle_for_closure = handle.clone();
    let _ = handle_for_call.run_on_main_thread(move || {
        let Some(window) = handle_for_closure.get_webview_window("main") else {
            return;
        };
        if !show_dock_icon {
            let _ = window.set_always_on_top(false);
        }
        let _ = window.hide();

        #[cfg(target_os = "macos")]
        if !show_dock_icon {
            set_dock_icon_visible_impl(false);
        }
    });
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
    pub bundle_identifier: Option<String>,
    pub name: String,
    pub icon_data_url: Option<String>,
}

#[tauri::command]
fn list_installed_apps() -> Vec<InstalledApp> {
    list_installed_apps_impl()
}

#[cfg(target_os = "macos")]
fn set_dock_icon_visible_impl(visible: bool) {
    use objc2::rc::autoreleasepool;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};

    autoreleasepool(|_| {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let app = NSApplication::sharedApplication(mtm);
        let policy = if visible {
            NSApplicationActivationPolicy::Regular
        } else {
            NSApplicationActivationPolicy::Accessory
        };
        let _ = app.setActivationPolicy(policy);
    });
}

#[cfg(not(target_os = "macos"))]
fn set_dock_icon_visible_impl(_visible: bool) {}

#[cfg(target_os = "macos")]
fn capture_frontmost() -> FrontmostAppInfo {
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::NSWorkspace;

    autoreleasepool(|_| {
        let workspace = NSWorkspace::sharedWorkspace();
        if let Some(frontmost) = workspace.frontmostApplication() {
            let bundle_identifier = frontmost.bundleIdentifier().map(|value| value.to_string());
            let name = frontmost.localizedName().map(|value| value.to_string());
            FrontmostAppInfo {
                bundle_identifier,
                name,
            }
        } else {
            FrontmostAppInfo {
                bundle_identifier: None,
                name: None,
            }
        }
    })
}

#[cfg(target_os = "macos")]
fn list_installed_apps_impl() -> Vec<InstalledApp> {
    use std::path::{Path, PathBuf};

    fn candidate_dirs() -> Vec<PathBuf> {
        let mut dirs = Vec::new();
        dirs.push(PathBuf::from("/Applications"));
        if let Some(home) = std::env::var_os("HOME") {
            dirs.push(PathBuf::from(home).join("Applications"));
        }
        dirs
    }

    fn read_plist_string(plist: &plist::Value, key: &str) -> Option<String> {
        plist
            .as_dictionary()
            .and_then(|dict| dict.get(key))
            .and_then(|value| value.as_string())
            .map(|value| value.to_string())
    }

    fn find_app_bundles(root: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(root) else {
            return out;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) == Some("app") {
                out.push(path);
            }
        }
        out
    }

    fn read_app_info(app_path: &Path) -> Option<InstalledApp> {
        let info_plist_path = app_path.join("Contents").join("Info.plist");
        let Ok(plist_value) = plist::Value::from_file(&info_plist_path) else {
            return None;
        };

        let bundle_identifier = read_plist_string(&plist_value, "CFBundleIdentifier");
        let mut name = read_plist_string(&plist_value, "CFBundleDisplayName")
            .or_else(|| read_plist_string(&plist_value, "CFBundleName"))
            .or_else(|| {
                app_path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .map(|value| value.to_string())
            })
            .unwrap_or_else(|| "App".to_string());

        if name.trim().is_empty() {
            name = "App".to_string();
        }

        let icon_data_url = app_icon_data_url(app_path, &plist_value);

        Some(InstalledApp {
            bundle_identifier,
            name,
            icon_data_url,
        })
    }

    fn app_icon_data_url(app_path: &Path, plist_value: &plist::Value) -> Option<String> {
        let icon_file = read_plist_string(plist_value, "CFBundleIconFile");
        let icon_name = icon_file.as_deref().unwrap_or("AppIcon");
        let icon_name = icon_name.strip_suffix(".icns").unwrap_or(icon_name);
        let resources_dir = app_path.join("Contents").join("Resources");

        let candidates = [
            resources_dir.join(format!("{icon_name}.icns")),
            resources_dir.join("AppIcon.icns"),
            resources_dir.join("Assets.car"), // ignored (placeholder to avoid rescans)
        ];

        let icns_path = candidates
            .iter()
            .find(|path| {
                path.extension().and_then(|ext| ext.to_str()) == Some("icns") && path.exists()
            })
            .cloned();

        let icns_path = icns_path?;
        let bytes = std::fs::read(icns_path).ok()?;
        let icon_family = icns::IconFamily::read(std::io::Cursor::new(bytes)).ok()?;

        // Prefer higher-res PNG encodings; fall back to anything we can decode.
        let best = icon_family
            .available_icons()
            .iter()
            .copied()
            .max_by_key(|icon_type| icon_type.pixel_width() * icon_type.pixel_height());

        let icon_type = best?;
        let icon = icon_family.get_icon_with_type(icon_type).ok()?;
        let mut png = Vec::new();
        icon.write_png(std::io::Cursor::new(&mut png)).ok()?;

        let b64 = base64::engine::general_purpose::STANDARD.encode(png);
        Some(format!("data:image/png;base64,{b64}"))
    }

    let mut apps: Vec<InstalledApp> = candidate_dirs()
        .into_iter()
        .flat_map(|dir| find_app_bundles(&dir))
        .filter_map(|path| read_app_info(&path))
        .collect();

    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    apps
}

#[cfg(not(target_os = "macos"))]
fn list_installed_apps_impl() -> Vec<InstalledApp> {
    Vec::new()
}

#[cfg(not(target_os = "macos"))]
fn capture_frontmost() -> FrontmostAppInfo {
    FrontmostAppInfo {
        bundle_identifier: None,
        name: None,
    }
}

fn bring_main_window_to_front(handle: &AppHandle, show_dock_icon: bool) {
    let handle_for_call = handle.clone();
    let handle_for_closure = handle.clone();
    let _ = handle_for_call.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        if show_dock_icon {
            activate_app();
        }

        let Some(window) = handle_for_closure.get_webview_window("main") else {
            return;
        };

        if !show_dock_icon {
            let _ = window.set_always_on_top(true);
        }

        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();

        #[cfg(target_os = "macos")]
        {
            use objc2::rc::autoreleasepool;
            use objc2_app_kit::NSWindow;

            autoreleasepool(|_| {
                let Ok(ptr) = window.ns_window() else {
                    return;
                };
                let ns_window: &NSWindow = unsafe { (ptr as *mut NSWindow).as_ref().unwrap() };
                ns_window.orderFrontRegardless();
                ns_window.makeKeyAndOrderFront(None);
            });
        }
    });
}

#[cfg(target_os = "macos")]
fn activate_app() {
    use objc2::rc::autoreleasepool;
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;

    autoreleasepool(|_| {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let app = NSApplication::sharedApplication(mtm);
        app.activate();
    });
}

fn normalize_exclusion_entry(entry: &Option<String>) -> String {
    entry
        .as_ref()
        .map(|value| value.trim().to_lowercase())
        .unwrap_or_default()
}

fn is_frontmost_excluded(frontmost: &FrontmostAppInfo, settings: &Settings) -> bool {
    let bundle = normalize_exclusion_entry(&frontmost.bundle_identifier);
    let name = normalize_exclusion_entry(&frontmost.name);
    if bundle.is_empty() && name.is_empty() {
        return false;
    }

    settings.excluded_apps.iter().any(|rule| {
        let normalized_rule = rule.trim().to_lowercase();
        if normalized_rule.is_empty() {
            return false;
        }
        (!bundle.is_empty() && bundle == normalized_rule)
            || (!name.is_empty() && name == normalized_rule)
    })
}

fn compute_signature(value: &str) -> (i32, usize) {
    let mut hash: i32 = 0;
    for ch in value.chars() {
        hash = hash
            .wrapping_shl(5)
            .wrapping_sub(hash)
            .wrapping_add(ch as i32);
    }
    (hash, value.len())
}

fn is_probably_code_snippet(input: &str) -> bool {
    if input.is_empty() {
        return false;
    }
    if input.contains('\t') {
        return true;
    }
    if input.contains("```") {
        return true;
    }
    let mut saw_multiline = false;
    for line in input.lines() {
        if !line.is_empty() {
            saw_multiline = true;
        }
        // Equivalent to `/^\s{2,}\S/m`
        let mut indent_width = 0usize;
        let mut content_start = line.len();
        for (index, ch) in line.char_indices() {
            if ch == ' ' {
                indent_width += 1;
                continue;
            }
            if ch == '\t' {
                // treat tabs as indent too
                indent_width += 2;
                continue;
            }
            content_start = index;
            break;
        }
        if indent_width >= 2 && line[content_start..].trim().len() > 0 {
            return true;
        }
    }
    if saw_multiline {
        // Rough stack trace heuristic: `/^\s*at\s+\S+/m` and contains newline.
        if input
            .lines()
            .any(|line| line.trim_start().starts_with("at ") && line.trim().len() > 3)
        {
            return true;
        }
    }
    false
}

fn is_effectively_empty(value: &str) -> bool {
    value
        .chars()
        .filter(|ch| !ch.is_whitespace() && *ch != '"' && *ch != '\'' && *ch != '`')
        .next()
        .is_none()
}

fn normalize_code_frame_line(line: &str) -> Option<String> {
    // Normalize Vite/TS/Node style code frames:
    //   "  690 |               const x" -> "690 | const x"
    //   "> 692 |     foo" -> "> 692 | foo"
    let mut s = line.trim_start();
    let mut pointer = "";
    if let Some(rest) = s.strip_prefix('>') {
        pointer = "> ";
        s = rest.trim_start();
    }

    let mut digits = String::new();
    for ch in s.chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
        } else {
            break;
        }
    }
    if digits.is_empty() {
        return None;
    }
    let rest = &s[digits.len()..];
    let rest = rest.trim_start();
    let rest = rest.strip_prefix('|')?;
    let rest = rest.trim_start();
    if rest.is_empty() {
        return None;
    }
    Some(format!("{pointer}{} | {}", digits, rest.trim_start()))
}

fn has_code_frame_prefix(line: &str) -> bool {
    let mut s = line.trim_start();
    if let Some(rest) = s.strip_prefix('>') {
        s = rest.trim_start();
    }

    let digit_count = s.chars().take_while(|ch| ch.is_ascii_digit()).count();
    if digit_count == 0 {
        return false;
    }

    s[digit_count..].trim_start().starts_with('|')
}

fn should_collapse_diagnostic_line(line: &str) -> bool {
    let trimmed_start = line.trim_start();
    if trimmed_start.is_empty() {
        return false;
    }
    if trimmed_start.starts_with("```") {
        return false;
    }
    if trimmed_start.starts_with("at ") {
        return false;
    }
    if has_code_frame_prefix(trimmed_start) {
        return false;
    }
    true
}

fn normalize_invisible_characters(
    input: &str,
    replace_nbsp: bool,
    remove_zero_width: bool,
) -> String {
    let mut out = input.to_string();
    if replace_nbsp {
        out = out.replace('\u{00A0}', " ");
    }
    if remove_zero_width {
        out = out
            .chars()
            .filter(|ch| !matches!(*ch, '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{FEFF}'))
            .collect();
    }
    out
}

fn collapse_inline_spacing_line(input: &str) -> String {
    // Equivalent to `/[ \t]{2,}/g` -> `' '`
    let mut out = String::with_capacity(input.len());
    let mut pending_ws = String::new();
    for ch in input.chars() {
        if ch == ' ' || ch == '\t' {
            pending_ws.push(ch);
            continue;
        }
        if !pending_ws.is_empty() {
            if pending_ws.chars().count() >= 2 {
                out.push(' ');
            } else {
                out.push_str(&pending_ws);
            }
            pending_ws.clear();
        }
        out.push(ch);
    }
    if !pending_ws.is_empty() {
        if pending_ws.chars().count() >= 2 {
            out.push(' ');
        } else {
            out.push_str(&pending_ws);
        }
    }
    out
}

fn collapse_blank_lines(input: &str) -> String {
    // Equivalent to `(\r?\n){3,}` -> `\n\n`
    let mut out = String::with_capacity(input.len());
    let mut newline_run = 0usize;
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '\r' {
            if chars.peek() == Some(&'\n') {
                let _ = chars.next();
            }
            newline_run += 1;
            continue;
        }
        if ch == '\n' {
            newline_run += 1;
            continue;
        }

        if newline_run > 0 {
            if newline_run >= 3 {
                out.push('\n');
                out.push('\n');
            } else {
                for _ in 0..newline_run {
                    out.push('\n');
                }
            }
            newline_run = 0;
        }

        out.push(ch);
    }

    if newline_run > 0 {
        if newline_run >= 3 {
            out.push('\n');
            out.push('\n');
        } else {
            for _ in 0..newline_run {
                out.push('\n');
            }
        }
    }

    out
}

fn remove_trailing_spaces(input: &str) -> String {
    // Equivalent to `/[ \t]+(?=\r?\n)/g`
    let mut out = String::with_capacity(input.len());
    let mut pending_ws: String = String::new();
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == ' ' || ch == '\t' {
            pending_ws.push(ch);
            continue;
        }

        if ch == '\r' {
            // Drop pending whitespace before newline.
            pending_ws.clear();
            if ch == '\r' && chars.peek() == Some(&'\n') {
                let _ = chars.next();
                out.push_str("\r\n");
            } else {
                out.push('\r');
            }
            continue;
        }

        if ch == '\n' {
            // Drop pending whitespace before newline.
            pending_ws.clear();
            out.push('\n');
            continue;
        }

        if !pending_ws.is_empty() {
            out.push_str(&pending_ws);
            pending_ws.clear();
        }
        out.push(ch);
    }

    // Keep trailing whitespace at end-of-string (JS regex doesn't remove it unless newline follows).
    if !pending_ws.is_empty() {
        out.push_str(&pending_ws);
    }

    out
}

fn build_flexible_phrase_regex(phrase: &str) -> Option<Regex> {
    let trimmed = phrase.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut pattern = String::new();
    let zero_width_optional = r"[\u{200B}\u{200C}\u{200D}\u{FEFF}]*";
    let wildcard_any_length = r"[^\r\n]*?";
    let mut escaping = false;
    let mut has_literal_token = false;

    let mut chars = trimmed.chars().peekable();
    while let Some(ch) = chars.next() {
        if escaping {
            pattern.push_str(&regex::escape(&ch.to_string()));
            pattern.push_str(zero_width_optional);
            has_literal_token = true;
            escaping = false;
            continue;
        }

        if ch == '\\' {
            escaping = true;
            continue;
        }

        if ch == '#' {
            pattern.push_str(&regex::escape(&ch.to_string()));
            pattern.push_str(zero_width_optional);
            has_literal_token = true;
            continue;
        }

        if ch == '*' {
            let mut run_len: usize = 1;
            while chars.peek() == Some(&'*') {
                let _ = chars.next();
                run_len += 1;
            }

            if run_len == 1 {
                // `*` matches any characters on a single line (including digits, punctuation, spaces).
                pattern.push_str(wildcard_any_length);
            } else {
                // `**`, `***`, etc match an exact character count. Useful for timestamps like `**:**:**.***`.
                pattern.push_str(&format!(r"[^\r\n]{{{}}}", run_len));
            }
            continue;
        }

        if ch == ' ' || ch == '\t' || ch == '\u{00A0}' {
            pattern.push_str(r"[ \t\u{00A0}]+");
            has_literal_token = true;
            continue;
        }

        pattern.push_str(&regex::escape(&ch.to_string()));
        pattern.push_str(zero_width_optional);
        has_literal_token = true;
    }

    if escaping {
        pattern.push_str(r"\\");
        has_literal_token = true;
    }

    if !has_literal_token {
        return None;
    }

    // Match case-insensitively to behave like the frontend (and what users expect).
    Regex::new(&format!("(?i:{pattern})")).ok()
}

fn remove_configured_phrases(input: &str, phrases: &[String]) -> String {
    if phrases.is_empty() {
        return input.to_string();
    }

    let mut regexes: Vec<Regex> = Vec::new();
    for phrase in phrases {
        if let Some(re) = build_flexible_phrase_regex(phrase) {
            regexes.push(re);
        }
    }
    if regexes.is_empty() {
        return input.to_string();
    }

    let mut out = input.to_string();
    for re in &regexes {
        out = re.replace_all(&out, "").to_string();
    }
    out
}

fn sanitize_clipboard_text(input: &str, settings: &Settings) -> String {
    const NO_PASTABLE_TEXT: &str = "[no pastable text]";

    let mut result = normalize_invisible_characters(
        input,
        settings.rule_flags.replace_non_breaking_spaces,
        settings.rule_flags.remove_zero_width_spaces,
    );

    let looks_like_code = is_probably_code_snippet(&result);
    let is_multiline = result.contains('\n') || result.contains('\r');

    if looks_like_code && is_multiline {
        let newline = if result.contains("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        let lines: Vec<&str> = result.lines().collect();
        let normalized: Vec<String> = lines
            .into_iter()
            .map(|line| {
                if let Some(frame) = normalize_code_frame_line(line) {
                    return frame;
                }
                if settings.rule_flags.collapse_inline_spacing
                    && should_collapse_diagnostic_line(line)
                {
                    return collapse_inline_spacing_line(line);
                }
                line.to_string()
            })
            .collect();
        result = normalized.join(newline);
    }

    result = remove_configured_phrases(&result, &settings.phrase_filters);
    if is_effectively_empty(&result) {
        return NO_PASTABLE_TEXT.to_string();
    }

    if settings.rule_flags.collapse_inline_spacing && !looks_like_code {
        result = collapse_inline_spacing_line(&result);
    }
    if settings.rule_flags.collapse_blank_lines {
        result = collapse_blank_lines(&result);
    }
    if settings.rule_flags.remove_trailing_spaces {
        result = remove_trailing_spaces(&result);
    }
    if settings.trim_whitespace && !looks_like_code {
        result = result.trim().to_string();
    }

    if is_effectively_empty(&result) {
        return NO_PASTABLE_TEXT.to_string();
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phrase_hashes_match_literal_text() {
        let phrases = vec!["##".to_string()];

        assert_eq!(
            remove_configured_phrases("ticket ## stays 42", &phrases),
            "ticket  stays 42"
        );
    }

    #[test]
    fn multiline_phrase_removal_keeps_surrounding_text() {
        let mut settings = normalize_settings(default_settings());
        settings.phrase_filters = vec!["remove me".to_string()];

        assert_eq!(
            sanitize_clipboard_text("alpha\nremove me but keep suffix\nomega", &settings),
            "alpha\n but keep suffix\nomega"
        );
    }

    #[test]
    fn wildcard_removal_uses_smallest_same_line_span() {
        let phrases = vec!["build * failed".to_string()];

        assert_eq!(
            remove_configured_phrases("first\nbuild step failed and keep\nlast", &phrases),
            "first\n and keep\nlast"
        );
    }

    #[test]
    fn settings_lists_split_and_dedupe_lines() {
        let mut settings = default_settings();
        settings.phrase_filters = vec![" Foo\nbar ".to_string(), "foo".to_string()];
        settings.excluded_apps = vec!["Terminal\r\niTerm2".to_string(), "terminal".to_string()];

        let normalized = normalize_settings(settings);

        assert_eq!(normalized.phrase_filters, vec!["Foo", "bar"]);
        assert_eq!(normalized.excluded_apps, vec!["Terminal", "iTerm2"]);
    }

    #[test]
    fn unicode_indented_code_detection_does_not_panic() {
        let settings = normalize_settings(default_settings());

        assert_eq!(
            sanitize_clipboard_text("\t世界\nok", &settings),
            "\t世界\nok"
        );
    }
}

fn try_reload_settings_from_disk(handle: &AppHandle, state: &CleanerState) {
    let Ok(mut last) = state.last_disk_reload.lock() else {
        return;
    };
    if last.elapsed() < Duration::from_secs(2) {
        return;
    }
    *last = Instant::now();

    let Ok(config_dir) = handle.path().app_config_dir() else {
        return;
    };
    let path = config_dir.join(SETTINGS_FOLDER).join(SETTINGS_FILE);
    let Ok(payload) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(loaded) = serde_json::from_str::<Settings>(&payload) else {
        return;
    };
    if let Ok(mut guard) = state.settings.lock() {
        *guard = normalize_settings(loaded);
    }
}

fn start_background_cleaner(handle: AppHandle, state: Arc<CleanerState>) {
    tauri::async_runtime::spawn_blocking(move || loop {
        try_reload_settings_from_disk(&handle, &state);

        let settings = match state.settings.lock() {
            Ok(guard) => guard.clone(),
            Err(_) => default_settings(),
        };

        let interval = settings.polling_interval_ms.max(50);

        if !settings.enabled {
            thread::sleep(Duration::from_millis(interval));
            continue;
        }

        let frontmost = capture_frontmost();
        if is_frontmost_excluded(&frontmost, &settings) {
            thread::sleep(Duration::from_millis(interval));
            continue;
        }

        let raw = match handle.clipboard().read_text() {
            Ok(text) => text,
            Err(_) => {
                thread::sleep(Duration::from_millis(interval));
                continue;
            }
        };
        let raw_signature = compute_signature(&raw);
        {
            if let Ok(mut guard) = state.last_raw_signature.lock() {
                if *guard == raw_signature {
                    thread::sleep(Duration::from_millis(interval));
                    continue;
                }
                *guard = raw_signature;
            }
        }

        let cleaned = sanitize_clipboard_text(&raw, &settings);
        let cleaned_signature = compute_signature(&cleaned);
        {
            if let Ok(guard) = state.last_written_signature.lock() {
                if *guard == cleaned_signature {
                    thread::sleep(Duration::from_millis(interval));
                    continue;
                }
            }
        }

        if cleaned != raw {
            if handle.clipboard().write_text(cleaned.clone()).is_ok() {
                if let Ok(mut guard) = state.last_written_signature.lock() {
                    *guard = cleaned_signature;
                }
                let timestamp = chrono::Utc::now().to_rfc3339();
                let _ = handle.emit(LAST_CLEANED_EVENT, LastCleanedPayload { timestamp });
            }
        }

        thread::sleep(Duration::from_millis(interval));
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cleaner_state = Arc::new(CleanerState::new());
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            get_frontmost_app,
            set_settings,
            exit_app,
            show_main_window,
            hide_main_window,
            set_dock_icon_visible,
            list_installed_apps
        ])
        .manage(cleaner_state.clone())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                #[cfg(target_os = "macos")]
                {
                    if let Some(state) = window.try_state::<Arc<CleanerState>>() {
                        let show_dock_icon = state
                            .settings
                            .lock()
                            .map(|guard| guard.show_dock_icon)
                            .unwrap_or(true);
                        if !show_dock_icon {
                            set_dock_icon_visible_impl(false);
                        }
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    start_background_cleaner(app.handle().clone(), cleaner_state.clone());

    app.run(move |handle, event| {
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } = event
        {
            let show_dock_icon = cleaner_state
                .settings
                .lock()
                .map(|guard| guard.show_dock_icon)
                .unwrap_or(true);
            bring_main_window_to_front(handle, show_dock_icon);
        }
    });
}
