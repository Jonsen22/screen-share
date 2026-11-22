# screen-share

Lightweight Windows desktop screen sharer built with **Tauri v2**, **WebRTC**, and **Windows WASAPI Process Loopback** per-application audio capture.

## Features
- **Ultra-lightweight desktop app:** Tauri v2 (Rust backend + native Windows WebView2 + Vanilla TypeScript/CSS).
- **Direct P2P WebRTC streaming:** 1 Host → up to 5 Viewers over encrypted DTLS-SRTP UDP.
- **Per-application audio only (Discord-style):** Uses Windows 10 (20348+) / Windows 11 WASAPI Process Loopback (`VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK`) to capture only the selected application's audio (and its child processes) — never leaking system notifications or voice chat. Switch or mute audio live mid-stream without renegotiating WebRTC.
- **Quality & encoding controls:** 720p30, 1080p30, 1080p60, or Native Source 60fps with Motion vs. Text/Detail `contentHint` and stereo 128 kbps Opus audio.
- **Viewer telemetry HUD:** Press `I` while watching to toggle live Resolution, FPS, Bitrate, RTT, Packet Loss, and Codec stats. Press `F` or double-click for fullscreen.

## Project Structure
- `app/` — Tauri v2 Windows desktop application (Host & Viewer in one binary)
  - `src/` — Vanilla TypeScript UI, WebRTC Host/Viewer managers, and AudioWorklet PCM bridge
  - `src-tauri/` — Rust backend with Win32 window/process enumeration and WASAPI Process Loopback capture
- `signaling-server/` — Minimal Node.js WebSocket server for room codes, SDP, and ICE relay (enforces max 5 viewers)

## Prerequisites (Windows)
- Windows 10 (build 20348+) or Windows 11
- Node.js LTS & npm
- Rust (`rustup` / `cargo`)
- Visual Studio C++ Build Tools (MSVC)
- Microsoft Edge WebView2 (pre-installed on Windows 10/11)

## Quick Start

### 1. Start the Signaling Server
```powershell
cd signaling-server
npm install
npm start
```
The server listens on `ws://0.0.0.0:8787` by default (override with `PORT` env var).

### 2. Run the Desktop App (Dev Mode)
In a second terminal:
```powershell
cd app
npm install
npm run tauri dev
```

### 3. Build a Release Installer / Binary
```powershell
cd app
npm run tauri build
```

## Streaming Across Different PCs
1. Host `signaling-server` on any machine reachable by both Host and Viewers (LAN IP, Tailscale IP, or a small VPS with `wss://`).
2. Enter the server URL in the top-right **Signaling** field of the app (e.g., `ws://192.168.1.50:8787`).
3. Click **Share Screen → Pick Screen & Start Sharing**, choose a target app for audio, and send the 8-character Room Code (e.g. `ABCD-1234`) to up to 5 viewers.
