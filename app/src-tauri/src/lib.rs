mod audio_capture;
mod deep_link;
mod discord;
mod windows_list;

use audio_capture::{AudioCaptureManager, LoopbackMode};
use std::sync::Mutex;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Manager, State, WindowEvent};
use windows_list::{AudioAppInfo, DiscordProcessInfo};

pub struct AppState {
    audio: Mutex<AudioCaptureManager>,
    pending_join_code: Mutex<Option<String>>,
}

#[tauri::command]
fn list_audio_apps() -> Result<Vec<AudioAppInfo>, String> {
    windows_list::enumerate_audio_apps()
}

#[tauri::command]
fn find_discord_app() -> Option<DiscordProcessInfo> {
    windows_list::find_discord_root_process()
}

#[tauri::command]
fn start_app_audio(
    pid: Option<u32>,
    exclude: Option<bool>,
    on_audio: Channel<InvokeResponseBody>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut manager = state
        .audio
        .lock()
        .map_err(|_| "Audio capture state lock poisoned".to_string())?;

    if exclude.unwrap_or(false) {
        let target_pid = pid
            .or_else(|| windows_list::find_discord_root_process().map(|d| d.pid))
            .unwrap_or_else(std::process::id);
        manager.start(target_pid, LoopbackMode::Exclude, on_audio)
    } else {
        let target_pid = pid.ok_or_else(|| "Missing target process PID".to_string())?;
        manager.start(target_pid, LoopbackMode::Include, on_audio)
    }
}

#[tauri::command]
fn stop_app_audio(state: State<'_, AppState>) -> Result<(), String> {
    let mut manager = state
        .audio
        .lock()
        .map_err(|_| "Audio capture state lock poisoned".to_string())?;
    manager.stop();
    Ok(())
}

#[tauri::command]
fn take_pending_join_code(state: State<'_, AppState>) -> Option<String> {
    state.pending_join_code.lock().ok()?.take()
}

#[tauri::command]
async fn send_discord_webhook(
    webhook_url: String,
    host_nickname: String,
    room_code: String,
    join_url: String,
    quality: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        discord::send_webhook(&webhook_url, &host_nickname, &room_code, &join_url, &quality)
    })
    .await
    .map_err(|e| format!("Discord webhook task failed: {e}"))?
}

const ALLOWED_EXTERNAL_URL_PREFIX: &str = "https://github.com/Jonsen22/screen-share/";
const MAX_EXTERNAL_URL_LEN: usize = 256;

fn validate_external_release_url(url: &str) -> Result<&str, String> {
    let trimmed = url.trim();
    if !trimmed.starts_with(ALLOWED_EXTERNAL_URL_PREFIX) {
        return Err(
            "URL must start with https://github.com/Jonsen22/screen-share/".to_string(),
        );
    }
    if trimmed.len() > MAX_EXTERNAL_URL_LEN {
        return Err("URL exceeds maximum allowed length".to_string());
    }
    if trimmed.contains("..") {
        return Err("URL must not contain path traversal segments".to_string());
    }
    let valid_chars = trimmed.bytes().all(|b| {
        b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'/' | b'-' | b'_' | b'.' | b':' | b'?' | b'=' | b'#' | b'%'
            )
    });
    if !valid_chars {
        return Err("URL contains disallowed characters".to_string());
    }
    Ok(trimmed)
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let validated = validate_external_release_url(&url)?;

    #[cfg(windows)]
    {
        use windows::core::{w, PCWSTR};
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let wide_url: Vec<u16> = validated.encode_utf16().chain(std::iter::once(0)).collect();
        let result = unsafe {
            ShellExecuteW(
                None,
                w!("open"),
                PCWSTR(wide_url.as_ptr()),
                None,
                None,
                SW_SHOWNORMAL,
            )
        };
        if (result.0 as isize) <= 32 {
            return Err(format!(
                "Failed to open URL in default browser (error code {})",
                result.0 as isize
            ));
        }
        Ok(())
    }

    #[cfg(not(windows))]
    {
        let _ = validated;
        Err("Opening external URLs is only supported on Windows".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    deep_link::register_protocol_handler();
    let initial_join_code = deep_link::parse_join_code_from_args();

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState {
            audio: Mutex::new(AudioCaptureManager::new()),
            pending_join_code: Mutex::new(initial_join_code),
        })
        .invoke_handler(tauri::generate_handler![
            list_audio_apps,
            find_discord_app,
            start_app_audio,
            stop_app_audio,
            take_pending_join_code,
            send_discord_webhook,
            open_external_url,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<AppState>() {
                    if let Ok(mut manager) = state.audio.lock() {
                        manager.stop();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running screen-share application");
}

#[cfg(test)]
mod tests {
    use super::validate_external_release_url;

    #[test]
    fn allows_valid_release_urls() {
        assert_eq!(
            validate_external_release_url(
                "https://github.com/Jonsen22/screen-share/releases/latest"
            ),
            Ok("https://github.com/Jonsen22/screen-share/releases/latest")
        );
        assert_eq!(
            validate_external_release_url(
                "  https://github.com/Jonsen22/screen-share/releases/tag/v2.1.0  "
            ),
            Ok("https://github.com/Jonsen22/screen-share/releases/tag/v2.1.0")
        );
    }

    #[test]
    fn rejects_non_repo_and_insecure_schemes() {
        assert!(validate_external_release_url("https://example.com/releases/latest").is_err());
        assert!(
            validate_external_release_url("http://github.com/Jonsen22/screen-share/releases")
                .is_err()
        );
        assert!(validate_external_release_url("javascript:alert(1)").is_err());
        assert!(validate_external_release_url(
            "https://github.com/Jonsen22/screen-share-evil/releases"
        )
        .is_err());
    }

    #[test]
    fn rejects_shell_metacharacters_whitespace_and_traversal() {
        assert!(validate_external_release_url(
            "https://github.com/Jonsen22/screen-share/releases/latest&calc.exe"
        )
        .is_err());
        assert!(validate_external_release_url(
            "https://github.com/Jonsen22/screen-share/releases/latest|whoami"
        )
        .is_err());
        assert!(validate_external_release_url(
            "https://github.com/Jonsen22/screen-share/releases/latest;ls"
        )
        .is_err());
        assert!(validate_external_release_url(
            "https://github.com/Jonsen22/screen-share/releases/latest --flag"
        )
        .is_err());
        assert!(validate_external_release_url(
            "https://github.com/Jonsen22/screen-share/releases/../other"
        )
        .is_err());
    }

    #[test]
    fn rejects_overlong_urls() {
        let long_url = format!(
            "https://github.com/Jonsen22/screen-share/releases/{}",
            "a".repeat(250)
        );
        assert!(validate_external_release_url(&long_url).is_err());
    }
}
