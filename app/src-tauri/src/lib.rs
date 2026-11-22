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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    deep_link::register_protocol_handler();
    let initial_join_code = deep_link::parse_join_code_from_args();

    tauri::Builder::default()
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
