import { AudioAppInfo, isTauriRuntime, listAudioApps } from "./audio/app-audio";
import { ContentHintMode, HostManager, QualityPresetId } from "./webrtc/host";
import { normalizeSignalingUrl } from "./webrtc/signaling";
import { ViewerManager } from "./webrtc/viewer";

const SIGNALING_STORAGE_KEY = "screen-share.signaling-url";
const DEFAULT_SIGNALING_URL = "wss://screen-share-wfrh.onrender.com";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing required element #${id}`);
  return node as T;
}

// Navigation & Server Config
const tabHost = el<HTMLButtonElement>("tab-host");
const tabViewer = el<HTMLButtonElement>("tab-viewer");
const viewHost = el<HTMLElement>("view-host");
const viewViewer = el<HTMLElement>("view-viewer");
const signalingInput = el<HTMLInputElement>("signaling-url");

// Host elements
const hostSetup = el<HTMLElement>("host-setup");
const hostLive = el<HTMLElement>("host-live");
const presetSelect = el<HTMLSelectElement>("preset-select");
const hintSelect = el<HTMLSelectElement>("hint-select");
const audioAppSelect = el<HTMLSelectElement>("audio-app-select");
const liveAudioAppSelect = el<HTMLSelectElement>("live-audio-app-select");
const btnRefreshApps = el<HTMLButtonElement>("btn-refresh-apps");
const btnLiveRefreshApps = el<HTMLButtonElement>("btn-live-refresh-apps");
const btnStartShare = el<HTMLButtonElement>("btn-start-share");
const btnStopShare = el<HTMLButtonElement>("btn-stop-share");
const btnCopyCode = el<HTMLButtonElement>("btn-copy-code");
const btnHostMute = el<HTMLButtonElement>("btn-host-mute");
const hostPreview = el<HTMLVideoElement>("host-preview");
const hostRoomCode = el<HTMLElement>("host-room-code");
const hostVideoMeta = el<HTMLElement>("host-video-meta");
const hostViewerPill = el<HTMLElement>("host-viewer-pill");
const hostStatusText = el<HTMLElement>("host-status-text");
const hostAudioMeter = el<HTMLElement>("host-audio-meter");
const hostError = el<HTMLElement>("host-error");
const hostLiveError = el<HTMLElement>("host-live-error");

// Viewer elements
const viewerJoin = el<HTMLElement>("viewer-join");
const viewerStage = el<HTMLElement>("viewer-stage");
const viewerJoinForm = el<HTMLFormElement>("viewer-join-form");
const roomCodeInput = el<HTMLInputElement>("room-code-input");
const btnJoinRoom = el<HTMLButtonElement>("btn-join-room");
const viewerError = el<HTMLElement>("viewer-error");
const viewerVideoWrap = el<HTMLElement>("viewer-video-wrap");
const viewerVideo = el<HTMLVideoElement>("viewer-video");
const viewerBanner = el<HTMLElement>("viewer-banner");
const viewerBannerText = el<HTMLElement>("viewer-banner-text");
const viewerRoomBadge = el<HTMLElement>("viewer-room-badge");
const btnViewerMute = el<HTMLButtonElement>("btn-viewer-mute");
const viewerVolume = el<HTMLInputElement>("viewer-volume");
const btnToggleStats = el<HTMLButtonElement>("btn-toggle-stats");
const btnFullscreen = el<HTMLButtonElement>("btn-fullscreen");
const btnLeaveRoom = el<HTMLButtonElement>("btn-leave-room");
const statsHud = el<HTMLElement>("stats-hud");

const statRes = el<HTMLElement>("stat-res");
const statFps = el<HTMLElement>("stat-fps");
const statBitrate = el<HTMLElement>("stat-bitrate");
const statRtt = el<HTMLElement>("stat-rtt");
const statLoss = el<HTMLElement>("stat-loss");
const statCodec = el<HTMLElement>("stat-codec");
const statState = el<HTMLElement>("stat-state");

let activeMode: "host" | "viewer" = "host";
let isHosting = false;
let isWatching = false;
let meterRafId: number | null = null;
let currentRoomCode = "";

// Initialize persisted signaling URL
const savedUrl = window.localStorage.getItem(SIGNALING_STORAGE_KEY);
signalingInput.value =
  savedUrl && savedUrl !== "ws://localhost:8787"
    ? normalizeSignalingUrl(savedUrl)
    : DEFAULT_SIGNALING_URL;
signalingInput.addEventListener("change", () => {
  const val = normalizeSignalingUrl(signalingInput.value) || DEFAULT_SIGNALING_URL;
  signalingInput.value = val;
  window.localStorage.setItem(SIGNALING_STORAGE_KEY, val);
});

function getSignalingUrl(): string {
  const val = normalizeSignalingUrl(signalingInput.value) || DEFAULT_SIGNALING_URL;
  signalingInput.value = val;
  window.localStorage.setItem(SIGNALING_STORAGE_KEY, val);
  return val;
}

function showAlert(node: HTMLElement, message: string | null): void {
  if (!message) {
    node.textContent = "";
    node.classList.add("hidden");
  } else {
    node.textContent = message;
    node.classList.remove("hidden");
  }
}

function setMode(mode: "host" | "viewer"): void {
  if (isHosting || isWatching) return;
  activeMode = mode;
  tabHost.classList.toggle("active", mode === "host");
  tabHost.setAttribute("aria-selected", String(mode === "host"));
  tabViewer.classList.toggle("active", mode === "viewer");
  tabViewer.setAttribute("aria-selected", String(mode === "viewer"));
  viewHost.classList.toggle("active", mode === "host");
  viewViewer.classList.toggle("active", mode === "viewer");
}

function setTabsLocked(locked: boolean): void {
  tabHost.disabled = locked;
  tabViewer.disabled = locked;
  signalingInput.disabled = locked;
}

tabHost.addEventListener("click", () => setMode("host"));
tabViewer.addEventListener("click", () => setMode("viewer"));

// Populate Windows application audio dropdowns
function populateAppSelect(select: HTMLSelectElement, apps: AudioAppInfo[], preserveValue: string): void {
  select.innerHTML = "";
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "No Audio (Video Only)";
  select.appendChild(noneOpt);

  for (const app of apps) {
    const opt = document.createElement("option");
    opt.value = String(app.pid);
    const title =
      app.windowTitle.length > 52
        ? `${app.windowTitle.slice(0, 49)}...`
        : app.windowTitle;
    opt.textContent = `${app.processName} — ${title} (PID ${app.pid})`;
    select.appendChild(opt);
  }

  if (preserveValue && Array.from(select.options).some((o) => o.value === preserveValue)) {
    select.value = preserveValue;
  } else {
    select.value = "";
  }
}

async function refreshAudioApps(): Promise<void> {
  try {
    const apps = await listAudioApps();
    populateAppSelect(audioAppSelect, apps, audioAppSelect.value);
    populateAppSelect(liveAudioAppSelect, apps, liveAudioAppSelect.value);
  } catch (err) {
    showAlert(hostError, `Could not enumerate Windows apps: ${String(err)}`);
  }
}

btnRefreshApps.addEventListener("click", () => void refreshAudioApps());
btnLiveRefreshApps.addEventListener("click", () => void refreshAudioApps());

// Audio meter animation loop while hosting
function startMeterLoop(): void {
  const tick = () => {
    if (!isHosting) return;
    const level = hostManager.getAudioLevel();
    hostAudioMeter.style.width = `${Math.round(level * 100)}%`;
    meterRafId = window.requestAnimationFrame(tick);
  };
  meterRafId = window.requestAnimationFrame(tick);
}

function stopMeterLoop(): void {
  if (meterRafId !== null) {
    window.cancelAnimationFrame(meterRafId);
    meterRafId = null;
  }
  hostAudioMeter.style.width = "0%";
}

// Host Manager
const hostManager = new HostManager({
  onRoomCreated(code, maxViewers, previewStream) {
    isHosting = true;
    currentRoomCode = code;
    setTabsLocked(true);
    showAlert(hostError, null);
    showAlert(hostLiveError, null);

    hostRoomCode.textContent = code;
    hostViewerPill.textContent = `0 / ${maxViewers} Viewers`;
    hostStatusText.textContent = "Share this code with up to 5 viewers.";
    hostPreview.srcObject = previewStream;
    liveAudioAppSelect.value = audioAppSelect.value;
    btnHostMute.textContent = "Mute Audio";

    hostSetup.classList.add("hidden");
    hostLive.classList.remove("hidden");

    // Read resolved capture metadata once the first frame arrives
    hostPreview.onloadedmetadata = () => {
      hostVideoMeta.textContent = hostManager.getVideoMeta();
    };
    hostVideoMeta.textContent = hostManager.getVideoMeta();
    startMeterLoop();
  },

  onViewerCountChange(count, maxViewers) {
    hostViewerPill.textContent = `${count} / ${maxViewers} Viewers`;
    hostStatusText.textContent =
      count === 0
        ? "Waiting for viewers to join..."
        : `${count} ${count === 1 ? "viewer" : "viewers"} watching live.`;
  },

  onEnded(reason) {
    isHosting = false;
    currentRoomCode = "";
    stopMeterLoop();
    setTabsLocked(false);

    hostPreview.srcObject = null;
    hostLive.classList.add("hidden");
    hostSetup.classList.remove("hidden");
    btnStartShare.disabled = false;
    btnStartShare.textContent = "Pick Screen & Start Sharing";

    if (reason) {
      showAlert(hostError, reason);
    }
  },

  onError(message) {
    showAlert(hostLiveError, message);
  },
});

btnStartShare.addEventListener("click", async () => {
  showAlert(hostError, null);
  btnStartShare.disabled = true;
  btnStartShare.textContent = "Starting...";

  const selectedPid = audioAppSelect.value ? Number(audioAppSelect.value) : null;
  try {
    await hostManager.start({
      signalingUrl: getSignalingUrl(),
      preset: presetSelect.value as QualityPresetId,
      contentHint: hintSelect.value as ContentHintMode,
      audioPid: selectedPid,
    });
  } catch (err) {
    btnStartShare.disabled = false;
    btnStartShare.textContent = "Pick Screen & Start Sharing";
    showAlert(hostError, err instanceof Error ? err.message : String(err));
  }
});

btnStopShare.addEventListener("click", () => {
  void hostManager.stop();
});

btnCopyCode.addEventListener("click", async () => {
  if (!currentRoomCode) return;
  try {
    await navigator.clipboard.writeText(currentRoomCode);
    btnCopyCode.textContent = "Copied!";
    window.setTimeout(() => {
      btnCopyCode.textContent = "Copy";
    }, 1500);
  } catch {
    btnCopyCode.textContent = "Select & Ctrl+C";
  }
});

liveAudioAppSelect.addEventListener("change", async () => {
  showAlert(hostLiveError, null);
  const pid = liveAudioAppSelect.value ? Number(liveAudioAppSelect.value) : null;
  try {
    await hostManager.switchAudioApp(pid);
  } catch (err) {
    showAlert(hostLiveError, err instanceof Error ? err.message : String(err));
  }
});

btnHostMute.addEventListener("click", () => {
  const nextMuted = !hostManager.isAudioMuted();
  hostManager.setAudioMuted(nextMuted);
  btnHostMute.textContent = nextMuted ? "Unmute Audio" : "Mute Audio";
});

// Viewer Manager
const viewerManager = new ViewerManager({
  onJoined(code) {
    isWatching = true;
    setTabsLocked(true);
    showAlert(viewerError, null);
    viewerRoomBadge.textContent = `Room ${code}`;
    viewerJoin.classList.add("hidden");
    viewerStage.classList.remove("hidden");
  },

  onStream(stream) {
    if (viewerVideo.srcObject !== stream) {
      viewerVideo.srcObject = stream;
    }
    void viewerVideo.play().catch(() => {});
  },

  onBanner(text) {
    if (!text) {
      viewerBanner.classList.add("hidden");
    } else {
      viewerBannerText.textContent = text;
      viewerBanner.classList.remove("hidden");
    }
  },

  onStats(stats) {
    statRes.textContent = stats.resolution;
    statFps.textContent = stats.fps;
    statBitrate.textContent = stats.bitrate;
    statRtt.textContent = stats.rtt;
    statLoss.textContent = stats.packetLoss;
    statCodec.textContent = stats.codec;
    statState.textContent = stats.state;
  },

  onEnded(reason) {
    isWatching = false;
    setTabsLocked(false);

    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    }
    viewerVideo.srcObject = null;
    viewerStage.classList.add("hidden");
    viewerJoin.classList.remove("hidden");
    btnJoinRoom.disabled = false;
    btnJoinRoom.textContent = "Join Stream";

    if (reason) {
      showAlert(viewerError, reason);
    }
  },
});

// Auto-format room code input as XXXX-XXXX
roomCodeInput.addEventListener("input", () => {
  const cleaned = roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  roomCodeInput.value =
    cleaned.length > 4 ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}` : cleaned;
});

viewerJoinForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  showAlert(viewerError, null);

  const code = roomCodeInput.value.trim();
  if (code.length < 8) {
    showAlert(viewerError, "Enter a valid 8-character room code (e.g. ABCD-1234).");
    return;
  }

  btnJoinRoom.disabled = true;
  btnJoinRoom.textContent = "Connecting...";

  try {
    await viewerManager.join(getSignalingUrl(), code);
  } catch (err) {
    btnJoinRoom.disabled = false;
    btnJoinRoom.textContent = "Join Stream";
    showAlert(viewerError, err instanceof Error ? err.message : String(err));
  }
});

btnLeaveRoom.addEventListener("click", () => {
  viewerManager.leave();
});

viewerVolume.addEventListener("input", () => {
  const vol = Number(viewerVolume.value);
  viewerVideo.volume = vol;
  viewerVideo.muted = vol === 0;
  btnViewerMute.textContent = viewerVideo.muted ? "Unmute" : "Mute";
});

btnViewerMute.addEventListener("click", () => {
  viewerVideo.muted = !viewerVideo.muted;
  btnViewerMute.textContent = viewerVideo.muted ? "Unmute" : "Mute";
});

function toggleStats(): void {
  statsHud.classList.toggle("hidden");
}

async function toggleFullscreen(): Promise<void> {
  if (document.fullscreenElement) {
    await document.exitFullscreen().catch(() => {});
  } else {
    await viewerVideoWrap.requestFullscreen().catch(() => {});
  }
}

btnToggleStats.addEventListener("click", toggleStats);
btnFullscreen.addEventListener("click", () => void toggleFullscreen());
viewerVideo.addEventListener("dblclick", () => void toggleFullscreen());

window.addEventListener("keydown", (e) => {
  if (!isWatching || activeMode !== "viewer") return;
  if (e.key === "i" || e.key === "I") {
    toggleStats();
  } else if (e.key === "f" || e.key === "F") {
    void toggleFullscreen();
  }
});

// Initial app enumeration (in Tauri desktop runtime)
if (isTauriRuntime()) {
  void refreshAudioApps();
} else {
  const hint = document.createElement("option");
  hint.value = "";
  hint.textContent = "(Run in Tauri desktop app for per-app WASAPI audio)";
  hint.disabled = true;
  audioAppSelect.appendChild(hint);
}
