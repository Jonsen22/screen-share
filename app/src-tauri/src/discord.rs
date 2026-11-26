use serde_json::json;

const ALLOWED_WEBHOOK_HOSTS: &[&str] = &[
    "discord.com",
    "discordapp.com",
    "ptb.discord.com",
    "canary.discord.com",
];

/// Validates that the provided URL is an official Discord webhook HTTPS endpoint
/// and returns `(host, path_and_query)`.
pub fn parse_discord_webhook_url(raw: &str) -> Result<(String, String), String> {
    let trimmed = raw.trim();
    let without_scheme = trimmed
        .strip_prefix("https://")
        .ok_or_else(|| "Webhook URL must start with https://".to_string())?;

    let (host, path) = without_scheme
        .split_once('/')
        .ok_or_else(|| "Invalid Discord webhook URL.".to_string())?;

    let host_lower = host.to_ascii_lowercase();
    if !ALLOWED_WEBHOOK_HOSTS.contains(&host_lower.as_str()) {
        return Err("Webhook URL must point to discord.com.".to_string());
    }

    let full_path = format!("/{path}");
    if !full_path.starts_with("/api/webhooks/") || full_path.len() < 25 {
        return Err(
            "Invalid Discord webhook URL (expected https://discord.com/api/webhooks/...)."
                .to_string(),
        );
    }

    Ok((host_lower, full_path))
}

pub fn build_discord_payload(
    host_nickname: &str,
    room_code: &str,
    join_url: &str,
    quality: &str,
) -> String {
    let nickname = host_nickname.trim();
    let display_host = if nickname.is_empty() { "Someone" } else { nickname };

    let description = if join_url.starts_with("https://") || join_url.starts_with("http://") {
        format!(
            "**Click to join in 1 click:** {join_url}\n\nOr open **screen-share** → **Watch Stream** and enter room code `{room_code}`."
        )
    } else {
        format!(
            "Open **screen-share** → **Watch Stream** and enter room code `{room_code}`."
        )
    };

    let mut embed = json!({
        "title": format!("{display_host} is live on screen-share!"),
        "description": description,
        "color": 5793266, // Discord Blurple (#5865F2)
        "fields": [
            { "name": "Room Code", "value": format!("`{room_code}`"), "inline": true },
            { "name": "Quality", "value": quality, "inline": true }
        ],
        "footer": {
            "text": "Direct P2P (encrypted) · Only share room codes with people you trust"
        }
    });

    if join_url.starts_with("https://") || join_url.starts_with("http://") {
        embed["url"] = json!(join_url);
    }

    json!({
        "username": "screen-share",
        "embeds": [embed]
    })
    .to_string()
}

#[cfg(windows)]
pub fn send_webhook(
    webhook_url: &str,
    host_nickname: &str,
    room_code: &str,
    join_url: &str,
    quality: &str,
) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Networking::WinHttp::{
        WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryHeaders,
        WinHttpReceiveResponse, WinHttpSendRequest, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
        WINHTTP_FLAG_SECURE, WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
    };

    fn to_wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(Some(0)).collect()
    }

    let (host, path) = parse_discord_webhook_url(webhook_url)?;
    let body = build_discord_payload(host_nickname, room_code, join_url, quality);
    let body_bytes = body.as_bytes();

    unsafe {
        let agent = to_wide("screen-share/2.3.0");
        let session = WinHttpOpen(
            PCWSTR(agent.as_ptr()),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        );
        if session.is_null() {
            return Err("Failed to initialize Windows HTTP session.".to_string());
        }

        let host_w = to_wide(&host);
        let connect = WinHttpConnect(session, PCWSTR(host_w.as_ptr()), 443, 0);
        if connect.is_null() {
            let _ = WinHttpCloseHandle(session);
            return Err("Failed to connect to Discord.".to_string());
        }

        let verb_w = to_wide("POST");
        let path_w = to_wide(&path);
        let request = WinHttpOpenRequest(
            connect,
            PCWSTR(verb_w.as_ptr()),
            PCWSTR(path_w.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            std::ptr::null(),
            WINHTTP_FLAG_SECURE,
        );
        if request.is_null() {
            let _ = WinHttpCloseHandle(connect);
            let _ = WinHttpCloseHandle(session);
            return Err("Failed to create Discord HTTP request.".to_string());
        }

        let headers_w = to_wide("Content-Type: application/json\r\n");
        let send_res = WinHttpSendRequest(
            request,
            Some(&headers_w[..headers_w.len() - 1]),
            Some(body_bytes.as_ptr() as *const _),
            body_bytes.len() as u32,
            body_bytes.len() as u32,
            0,
        );

        let result = if send_res.is_err() {
            Err("Could not send request to Discord (check your internet connection).".to_string())
        } else if WinHttpReceiveResponse(request, std::ptr::null_mut()).is_err() {
            Err("No response received from Discord.".to_string())
        } else {
            let mut status_code: u32 = 0;
            let mut size = std::mem::size_of::<u32>() as u32;
            let q_res = WinHttpQueryHeaders(
                request,
                WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                PCWSTR::null(),
                Some(&mut status_code as *mut u32 as *mut _),
                &mut size,
                std::ptr::null_mut(),
            );
            if q_res.is_err() {
                Err("Could not read HTTP status from Discord.".to_string())
            } else if (200..300).contains(&status_code) {
                Ok(())
            } else if status_code == 401 || status_code == 404 {
                Err(format!(
                    "Discord rejected the webhook (HTTP {status_code}). Check your webhook URL."
                ))
            } else {
                Err(format!("Discord webhook returned HTTP {status_code}."))
            }
        };

        let _ = WinHttpCloseHandle(request);
        let _ = WinHttpCloseHandle(connect);
        let _ = WinHttpCloseHandle(session);
        result
    }
}

#[cfg(not(windows))]
pub fn send_webhook(
    _webhook_url: &str,
    _host_nickname: &str,
    _room_code: &str,
    _join_url: &str,
    _quality: &str,
) -> Result<(), String> {
    Err("Discord webhook posting is only supported on Windows.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_discord_webhook_urls() {
        assert!(parse_discord_webhook_url(
            "https://discord.com/api/webhooks/123456789012345678/abcdef1234567890"
        )
        .is_ok());
        assert!(parse_discord_webhook_url(
            "https://ptb.discord.com/api/webhooks/123456789012345678/abcdef1234567890"
        )
        .is_ok());
        assert!(parse_discord_webhook_url("http://discord.com/api/webhooks/1/2").is_err());
        assert!(parse_discord_webhook_url("https://evil.com/api/webhooks/1/2").is_err());
        assert!(parse_discord_webhook_url("https://discord.com/channels/1/2").is_err());
    }
}
