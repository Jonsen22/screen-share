use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioAppInfo {
    pub pid: u32,
    pub process_name: String,
    pub window_title: String,
    pub has_audio_session: bool,
    pub is_playing_audio: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordProcessInfo {
    pub pid: u32,
    pub process_name: String,
}

#[cfg(windows)]
pub fn find_discord_root_process() -> Option<DiscordProcessInfo> {
    use std::collections::HashSet;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    const DISCORD_NAMES: &[&str] = &["discord", "discordptb", "discordcanary", "vesktop"];

    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };

        let mut matches: Vec<(u32, u32, String)> = Vec::new();

        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let exe = String::from_utf16_lossy(&entry.szExeFile[..len]);
                let stem = exe
                    .strip_suffix(".exe")
                    .or_else(|| exe.strip_suffix(".EXE"))
                    .unwrap_or(&exe);
                let lower = stem.to_ascii_lowercase();
                if DISCORD_NAMES.contains(&lower.as_str()) {
                    matches.push((
                        entry.th32ProcessID,
                        entry.th32ParentProcessID,
                        stem.to_string(),
                    ));
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);

        if matches.is_empty() {
            return None;
        }

        // Find the top-most root process whose parent is NOT another Discord process,
        // so PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE excludes the entire
        // Discord process tree (including its audio/voice utility subprocess).
        let matching_pids: HashSet<u32> = matches.iter().map(|(pid, _, _)| *pid).collect();
        let chosen = matches
            .iter()
            .find(|(_, parent_pid, _)| !matching_pids.contains(parent_pid))
            .or_else(|| matches.first())?;

        Some(DiscordProcessInfo {
            pid: chosen.0,
            process_name: chosen.2.clone(),
        })
    }
}

#[cfg(not(windows))]
pub fn find_discord_root_process() -> Option<DiscordProcessInfo> {
    None
}

#[cfg(windows)]
pub fn enumerate_audio_apps() -> Result<Vec<AudioAppInfo>, String> {
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::path::Path;
    use windows::core::{Interface, PWSTR};
    use windows::Win32::Foundation::{BOOL, CloseHandle, FALSE, HWND, LPARAM, RPC_E_CHANGED_MODE, TRUE};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::Media::Audio::{
        eConsole, eRender, AudioSessionStateActive, AudioSessionStateExpired, IAudioSessionControl2,
        IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Threading::{
        GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, EnumWindows, GetShellWindow, GetWindowLongW, GetWindowTextLengthW,
        GetWindowTextW, GetWindowThreadProcessId, GWL_EXSTYLE, IsWindowVisible, WS_EX_TOOLWINDOW,
    };

    fn query_process_name(pid: u32) -> Option<String> {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = vec![0u16; 512];
            let mut size = buf.len() as u32;
            let res = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                PWSTR(buf.as_mut_ptr()),
                &mut size,
            );
            let _ = CloseHandle(handle);
            res.ok()?;

            let full = OsString::from_wide(&buf[..size as usize]);
            let file_name = Path::new(&full)
                .file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string())?;
            Some(file_name)
        }
    }

    /// Resolve UWP apps hosted inside ApplicationFrameHost.exe to their real CoreWindow PID.
    fn resolve_uwp_child_pid(parent_hwnd: HWND, host_pid: u32) -> u32 {
        struct ChildCtx {
            host_pid: u32,
            found_pid: u32,
        }

        unsafe extern "system" fn child_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let ctx = &mut *(lparam.0 as *mut ChildCtx);
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid != 0 && pid != ctx.host_pid {
                ctx.found_pid = pid;
                return FALSE;
            }
            TRUE
        }

        let mut ctx = ChildCtx {
            host_pid,
            found_pid: host_pid,
        };
        unsafe {
            let _ = EnumChildWindows(
                parent_hwnd,
                Some(child_cb),
                LPARAM(&mut ctx as *mut ChildCtx as isize),
            );
        }
        ctx.found_pid
    }

    /// Query Windows Volume Mixer (IAudioSessionManager2) for processes with active/open audio sessions.
    fn query_wasapi_audio_sessions(self_pid: u32) -> HashMap<u32, bool> {
        let mut sessions: HashMap<u32, bool> = HashMap::new();
        unsafe {
            let com_hr = CoInitializeEx(None, COINIT_MULTITHREADED);
            let should_uninit = com_hr.is_ok();
            if com_hr.is_err() && com_hr != RPC_E_CHANGED_MODE {
                return sessions;
            }

            let _ = (|| -> windows::core::Result<()> {
                let enumerator: IMMDeviceEnumerator =
                    CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
                let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
                let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
                let list = manager.GetSessionEnumerator()?;
                let count = list.GetCount()?;

                for i in 0..count {
                    let Ok(ctrl) = list.GetSession(i) else {
                        continue;
                    };
                    let Ok(ctrl2) = ctrl.cast::<IAudioSessionControl2>() else {
                        continue;
                    };
                    let Ok(pid) = ctrl2.GetProcessId() else {
                        continue;
                    };
                    if pid == 0 || pid == self_pid {
                        continue;
                    }
                    let state = ctrl.GetState().unwrap_or(AudioSessionStateExpired);
                    if state == AudioSessionStateExpired {
                        continue;
                    }
                    let is_active = state == AudioSessionStateActive;
                    sessions
                        .entry(pid)
                        .and_modify(|playing| {
                            if is_active {
                                *playing = true;
                            }
                        })
                        .or_insert(is_active);
                }
                Ok(())
            })();

            if should_uninit {
                CoUninitialize();
            }
        }
        sessions
    }

    struct EnumContext {
        self_pid: u32,
        shell_hwnd: HWND,
        by_pid: HashMap<u32, AudioAppInfo>,
    }

    unsafe extern "system" fn enum_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut EnumContext);

        if hwnd == ctx.shell_hwnd || !IsWindowVisible(hwnd).as_bool() {
            return TRUE;
        }

        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        if (ex_style & WS_EX_TOOLWINDOW.0) != 0 {
            return TRUE;
        }

        let mut cloaked: u32 = 0;
        let _ = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut _,
            std::mem::size_of::<u32>() as u32,
        );
        if cloaked != 0 {
            return TRUE;
        }

        let title_len = GetWindowTextLengthW(hwnd);
        if title_len <= 0 {
            return TRUE;
        }

        let mut title_buf = vec![0u16; (title_len as usize) + 1];
        let copied = GetWindowTextW(hwnd, &mut title_buf);
        if copied <= 0 {
            return TRUE;
        }
        let window_title = String::from_utf16_lossy(&title_buf[..copied as usize])
            .trim()
            .to_string();
        if window_title.is_empty() {
            return TRUE;
        }

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 || pid == ctx.self_pid {
            return TRUE;
        }

        let mut process_name = query_process_name(pid).unwrap_or_else(|| format!("PID {pid}"));
        if process_name.eq_ignore_ascii_case("ApplicationFrameHost") {
            let real_pid = resolve_uwp_child_pid(hwnd, pid);
            if real_pid != pid && real_pid != ctx.self_pid {
                pid = real_pid;
                process_name = query_process_name(pid).unwrap_or(process_name);
            }
        }

        if let Some(existing) = ctx.by_pid.get_mut(&pid) {
            if window_title.len() > existing.window_title.len() {
                existing.window_title = window_title;
            }
            return TRUE;
        }

        ctx.by_pid.insert(
            pid,
            AudioAppInfo {
                pid,
                process_name,
                window_title,
                has_audio_session: false,
                is_playing_audio: false,
            },
        );
        TRUE
    }

    let self_pid = unsafe { GetCurrentProcessId() };
    let mut ctx = EnumContext {
        self_pid,
        shell_hwnd: unsafe { GetShellWindow() },
        by_pid: HashMap::new(),
    };

    unsafe {
        EnumWindows(
            Some(enum_callback),
            LPARAM(&mut ctx as *mut EnumContext as isize),
        )
        .map_err(|e| format!("EnumWindows failed: {e}"))?;
    }

    // Merge active WASAPI audio sessions from Windows Volume Mixer
    let audio_sessions = query_wasapi_audio_sessions(self_pid);
    for (pid, is_playing) in audio_sessions {
        if let Some(existing) = ctx.by_pid.get_mut(&pid) {
            existing.has_audio_session = true;
            existing.is_playing_audio = is_playing;
        } else {
            let process_name = query_process_name(pid).unwrap_or_else(|| format!("PID {pid}"));
            let window_title = if is_playing {
                "Playing audio (background / audio process)".to_string()
            } else {
                "Open audio session".to_string()
            };
            ctx.by_pid.insert(
                pid,
                AudioAppInfo {
                    pid,
                    process_name,
                    window_title,
                    has_audio_session: true,
                    is_playing_audio: is_playing,
                },
            );
        }
    }

    let mut apps: Vec<AudioAppInfo> = ctx.by_pid.into_values().collect();
    apps.sort_by(|a, b| {
        b.is_playing_audio
            .cmp(&a.is_playing_audio)
            .then_with(|| b.has_audio_session.cmp(&a.has_audio_session))
            .then_with(|| a.process_name.to_lowercase().cmp(&b.process_name.to_lowercase()))
            .then_with(|| a.window_title.to_lowercase().cmp(&b.window_title.to_lowercase()))
    });
    Ok(apps)
}

#[cfg(not(windows))]
pub fn enumerate_audio_apps() -> Result<Vec<AudioAppInfo>, String> {
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enumerates_windows_without_error() {
        let apps = enumerate_audio_apps().expect("enumerate_audio_apps should succeed");
        for app in &apps {
            assert_ne!(app.pid, 0);
            assert!(!app.window_title.is_empty());
        }
    }
}
