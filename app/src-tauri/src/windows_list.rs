use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioAppInfo {
    pub pid: u32,
    pub process_name: String,
    pub window_title: String,
}

#[cfg(windows)]
pub fn enumerate_audio_apps() -> Result<Vec<AudioAppInfo>, String> {
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::path::Path;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{BOOL, CloseHandle, HWND, LPARAM, TRUE};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::System::Threading::{
        GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetShellWindow, GetWindowLongW, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, GWL_EXSTYLE, IsWindowVisible, WS_EX_TOOLWINDOW,
    };

    struct EnumContext {
        self_pid: u32,
        shell_hwnd: HWND,
        by_pid: HashMap<u32, AudioAppInfo>,
    }

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

    unsafe extern "system" fn enum_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut EnumContext);

        if hwnd == ctx.shell_hwnd || !IsWindowVisible(hwnd).as_bool() {
            return TRUE;
        }

        // Skip floating tool windows
        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        if (ex_style & WS_EX_TOOLWINDOW.0) != 0 {
            return TRUE;
        }

        // Skip cloaked UWP background windows
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

        if let Some(existing) = ctx.by_pid.get_mut(&pid) {
            // Keep the most descriptive (longest) top-level window title for this PID
            if window_title.len() > existing.window_title.len() {
                existing.window_title = window_title;
            }
            return TRUE;
        }

        let process_name = query_process_name(pid).unwrap_or_else(|| format!("PID {pid}"));
        ctx.by_pid.insert(
            pid,
            AudioAppInfo {
                pid,
                process_name,
                window_title,
            },
        );
        TRUE
    }

    let mut ctx = EnumContext {
        self_pid: unsafe { GetCurrentProcessId() },
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

    let mut apps: Vec<AudioAppInfo> = ctx.by_pid.into_values().collect();
    apps.sort_by(|a, b| {
        a.process_name
            .to_lowercase()
            .cmp(&b.process_name.to_lowercase())
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
