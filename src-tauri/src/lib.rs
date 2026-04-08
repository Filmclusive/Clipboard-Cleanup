use base64::Engine;
use serde::Serialize;
use tauri::AppHandle;
use tauri::WindowEvent;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontmostAppInfo {
  pub bundle_identifier: Option<String>,
  pub name: Option<String>
}

#[tauri::command]
fn get_frontmost_app() -> FrontmostAppInfo {
  capture_frontmost()
}

#[tauri::command]
fn exit_app(handle: AppHandle) {
  handle.exit(0);
}

#[tauri::command]
fn set_dock_icon_visible(visible: bool) {
  set_dock_icon_visible_impl(visible);
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
  pub bundle_identifier: Option<String>,
  pub name: String,
  pub icon_data_url: Option<String>
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
      let bundle_identifier = frontmost
        .bundleIdentifier()
        .map(|value| value.to_string());
      let name = frontmost.localizedName().map(|value| value.to_string());
      FrontmostAppInfo {
        bundle_identifier,
        name
      }
    } else {
      FrontmostAppInfo {
        bundle_identifier: None,
        name: None
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
      icon_data_url
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
      resources_dir.join("Assets.car") // ignored (placeholder to avoid rescans)
    ];

    let icns_path = candidates
      .iter()
      .find(|path| path.extension().and_then(|ext| ext.to_str()) == Some("icns") && path.exists())
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
    icon
      .write_png(std::io::Cursor::new(&mut png))
      .ok()?;

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
    name: None
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_clipboard_manager::init())
    .plugin(tauri_plugin_fs::init())
    .invoke_handler(tauri::generate_handler![
      get_frontmost_app,
      exit_app,
      set_dock_icon_visible,
      list_installed_apps
    ])
    .on_window_event(|window, event| {
      if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
