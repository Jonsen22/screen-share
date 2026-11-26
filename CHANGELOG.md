# Changelog

All notable changes to **screen-share** are documented in this file.

## [v2.2.0] - 2026-11-25

### Added
- **Always-on-Top Mini Player (PiP):** Pop out any watched stream into a frameless, floating window that stays above other apps (`P` shortcut or **Mini Player** button).
- **4-Corner Snap & Free Dragging:** Click the corner snap button to cycle through all four screen corners, or drag the Mini Player anywhere on your desktop with HiDPI and multi-monitor work-area clamping.
- **Hover Controls & Audio Sync:** Auto-hiding Mini Player overlay with mute/unmute, volume slider synced with the main viewer, corner snap, and one-click restore (`Esc`, `P`, or double-click).

## [v2.1.0] - 2026-11-25

### Added
- **In-App Self-Updater:** Download and install new Windows releases directly from the update banner with **Update Now**, live download progress bar, and automatic restart.
- **Live-Session Update Guard:** Prompts for confirmation before restarting if you are currently hosting or watching a stream, plus a fallback manual download link if an automatic update fails.

## [v2.0.1] - 2026-11-24

### Fixed
- Fixed `<select>` dropdown overflow in the co-stream share modal when application window titles are long.

## [v2.0.0] - 2026-11-24

### Added
- **Multi-Streamer P2P Rooms:** Viewers can now share their screen alongside the host in the same room and switch between active streams from the stream bar.
- **Watch-Only Web Client:** Friends without the Windows app can watch streams directly in their browser via the room invite link.
- **Room Moderation Controls:** Separate **Kick** and **Ban** actions for connected viewers, with a confirmation modal before banning an IP for the session.

### Security
- Added signaling server anti-DoS rate limiting, stricter connection limits, and LGPD admin controls.

## [v1.2.0] - 2026-11-22

### Added
- **One-Click Discord Sharing:** Configure a local Discord channel webhook to post your live room link and stream quality in one click.
- **Deep Link Support:** Open `screenshare://` invite links directly in the Windows desktop app to jump straight into a room.

## [v1.1.0] - 2026-11-22

### Fixed
- Resilient P2P signaling reconnects with WebSocket keepalives so brief network blips do not drop your active stream.
- Automatic host room reclaim when the signaling connection recovers.

## [v0.1.0] - 2026-11-22

### Added
- **Direct P2P WebRTC Screen Sharing:** Share your screen with up to 5 viewers using DTLS-SRTP encryption, live quality preset switching (`720p30`, `1080p30`, `1080p60`, `Native 60`), and seamless screen/window switching.
- **Windows WASAPI Per-App Audio:** Capture audio from a single selected application or use **All PC Audio (Exclude Discord)** so viewers never hear voice-call echo.
- **Stream Telemetry HUD:** Press `I` while watching to inspect live resolution, FPS, bitrate, audio, RTT latency, packet loss, and codec stats.
