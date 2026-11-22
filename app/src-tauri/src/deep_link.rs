/// Parses a `screenshare://join/ABCD-1234` URI into a normalized `XXXX-XXXX` room code.
pub fn parse_join_code(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_matches('"');
    let lower = trimmed.to_ascii_lowercase();
    let rest = lower.strip_prefix("screenshare://")?;
    let path = rest.strip_prefix("join/").unwrap_or(rest);
    let candidate = path
        .split(['?', '#', '/'])
        .next()
        .unwrap_or("")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_uppercase();

    if candidate.len() == 8 {
        Some(format!("{}-{}", &candidate[..4], &candidate[4..]))
    } else {
        None
    }
}

/// Scans process startup arguments for a `screenshare://join/<CODE>` deep link.
pub fn parse_join_code_from_args() -> Option<String> {
    std::env::args().skip(1).find_map(|arg| parse_join_code(&arg))
}

/// Registers the `screenshare://` custom URL protocol under HKCU (no admin required)
/// pointing to the currently running executable.
#[cfg(windows)]
pub fn register_protocol_handler() {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    fn to_wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(Some(0)).collect()
    }

    unsafe fn set_reg_sz(hkey: HKEY, name: Option<&str>, value: &str) {
        let name_wide = name.map(to_wide);
        let name_ptr = match &name_wide {
            Some(w) => PCWSTR(w.as_ptr()),
            None => PCWSTR::null(),
        };
        let val_wide = to_wide(value);
        let byte_slice = std::slice::from_raw_parts(
            val_wide.as_ptr() as *const u8,
            val_wide.len() * std::mem::size_of::<u16>(),
        );
        let _ = RegSetValueExW(hkey, name_ptr, 0, REG_SZ, Some(byte_slice));
    }

    let Ok(exe_path) = std::env::current_exe() else {
        return;
    };
    let exe_str = exe_path.to_string_lossy();
    let command = format!("\"{exe_str}\" \"%1\"");

    unsafe {
        let mut root_key = HKEY::default();
        let root_subkey = to_wide("Software\\Classes\\screenshare");
        if RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(root_subkey.as_ptr()),
            0,
            None,
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            None,
            &mut root_key,
            None,
        )
        .is_ok()
        {
            set_reg_sz(root_key, None, "URL:screen-share Protocol");
            set_reg_sz(root_key, Some("URL Protocol"), "");
            let _ = RegCloseKey(root_key);
        }

        let mut cmd_key = HKEY::default();
        let cmd_subkey = to_wide("Software\\Classes\\screenshare\\shell\\open\\command");
        if RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(cmd_subkey.as_ptr()),
            0,
            None,
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            None,
            &mut cmd_key,
            None,
        )
        .is_ok()
        {
            set_reg_sz(cmd_key, None, &command);
            let _ = RegCloseKey(cmd_key);
        }
    }
}

#[cfg(not(windows))]
pub fn register_protocol_handler() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_deep_link_codes() {
        assert_eq!(
            parse_join_code("screenshare://join/abcd-1234"),
            Some("ABCD-1234".to_string())
        );
        assert_eq!(
            parse_join_code("SCREENSHARE://join/abcd1234/"),
            Some("ABCD-1234".to_string())
        );
        assert_eq!(
            parse_join_code("screenshare://ABCD-1234?ref=discord"),
            Some("ABCD-1234".to_string())
        );
        assert_eq!(parse_join_code("https://example.com/join/ABCD-1234"), None);
        assert_eq!(parse_join_code("screenshare://join/SHORT"), None);
    }
}
