mod audio_capture;
mod windows_list;

use audio_capture::AudioCaptureManager;
use std::sync::Mutex;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Manager, State, WindowEvent};
use windows_list::AudioAppInfo;

pub struct AppState {
    audio: Mutex<AudioCaptureManager>,
}

#[tauri::command]
fn list_audio_apps() -> Result<Vec<AudioAppInfo>, String> {
    windows_list::enumerate_audio_apps()
}

#[tauri::command]
fn start_app_audio(
    pid: u32,
    on_audio: Channel<InvokeResponseBody>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut manager = state
        .audio
        .lock()
        .map_err(|_| "Audio capture state lock poisoned".to_string())?;
    manager.start(pid, on_audio)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            audio: Mutex::new(AudioCaptureManager::new()),
        })
        .invoke_handler(tauri::generate_handler![
            list_audio_apps,
            start_app_audio,
            stop_app_audio,
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
