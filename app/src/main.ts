import {
  AudioAppInfo,
  AudioCaptureTarget,
  DiscordProcessInfo,
  findDiscordApp,
  isTauriRuntime,
  listAudioApps,
} from "./audio/app-audio";
import { checkForAppUpdate, getCurrentAppVersion } from "./version-check";
import { ConnectedViewer, ContentHintMode, HostManager, QualityPresetId } from "./webrtc/host";
import { normalizeSignalingUrl } from "./webrtc/signaling";
import { ViewerManager } from "./webrtc/viewer";

const SIGNALING_STORAGE_KEY = import.meta.env.DEV
  ? "screen-share.signaling-url.dev"
  : "screen-share.signaling-url";
const NICKNAME_STORAGE_KEY = "screen-share.nickname";
const ONBOARDING_STORAGE_KEY = "screen-share.onboarding-seen";
const DISMISSED_UPDATE_KEY = "screen-share.dismissed-update";
const DEFAULT_SIGNALING_URL =
  normalizeSignalingUrl(import.meta.env.VITE_SIGNALING_URL ?? "") ||
  "wss://screen-share-wfrh.onrender.com";
const MAX_NICKNAME_LEN = 24;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing required element #${id}`);
  return node as T;
}

// Navigation, Server Config & Nickname
const tabHost = el<HTMLButtonElement>("tab-host");
const tabViewer = el<HTMLButtonElement>("tab-viewer");
const viewHost = el<HTMLElement>("view-host");
const viewViewer = el<HTMLElement>("view-viewer");
const signalingInput = el<HTMLInputElement>("signaling-url");
const btnEditNickname = el<HTMLButtonElement>("btn-edit-nickname");
const nicknameDisplay = el<HTMLElement>("nickname-display");
const nicknameModal = el<HTMLElement>("nickname-modal");
const nicknameModalTitle = el<HTMLElement>("nickname-modal-title");
const nicknameForm = el<HTMLFormElement>("nickname-form");
const nicknameInput = el<HTMLInputElement>("nickname-input");
const nicknameError = el<HTMLElement>("nickname-error");
const btnNicknameCancel = el<HTMLButtonElement>("btn-nickname-cancel");
const btnOpenIntro = el<HTMLButtonElement>("btn-open-intro");
const introModal = el<HTMLElement>("intro-modal");
const introAppVersion = el<HTMLElement>("intro-app-version");
const btnIntroClose = el<HTMLButtonElement>("btn-intro-close");
const updateBanner = el<HTMLElement>("update-banner");
const updateBannerMsg = el<HTMLElement>("update-banner-msg");
const updateDownloadLink = el<HTMLAnchorElement>("update-download-link");
const btnDismissUpdate = el<HTMLButtonElement>("btn-dismiss-update");

// Host elements
const hostSetup = el<HTMLElement>("host-setup");
const hostLive = el<HTMLElement>("host-live");
const presetSelect = el<HTMLSelectElement>("preset-select");
const hintSelect = el<HTMLSelectElement>("hint-select");
const livePresetSelect = el<HTMLSelectElement>("live-preset-select");
const liveHintSelect = el<HTMLSelectElement>("live-hint-select");
const audioAppSelect = el<HTMLSelectElement>("audio-app-select");
const liveAudioAppSelect = el<HTMLSelectElement>("live-audio-app-select");
const audioAppHint = el<HTMLElement>("audio-app-hint");
const liveAudioAppHint = el<HTMLElement>("live-audio-app-hint");
const btnRefreshApps = el<HTMLButtonElement>("btn-refresh-apps");
const btnLiveRefreshApps = el<HTMLButtonElement>("btn-live-refresh-apps");
const btnStartShare = el<HTMLButtonElement>("btn-start-share");
const btnSwitchScreen = el<HTMLButtonElement>("btn-switch-screen");
const btnStopShare = el<HTMLButtonElement>("btn-stop-share");
const btnCopyCode = el<HTMLButtonElement>("btn-copy-code");
const btnHostMonitor = el<HTMLButtonElement>("btn-host-monitor");
const btnHostMute = el<HTMLButtonElement>("btn-host-mute");
const hostPreview = el<HTMLVideoElement>("host-preview");
const hostRoomCode = el<HTMLElement>("host-room-code");
const hostVideoMeta = el<HTMLElement>("host-video-meta");
const hostViewerPill = el<HTMLElement>("host-viewer-pill");
const hostViewersCount = el<HTMLElement>("host-viewers-count");
const hostViewersList = el<HTMLUListElement>("host-viewers-list");
const hostStatusText = el<HTMLElement>("host-status-text");
const hostAudioStatus = el<HTMLElement>("host-audio-status");
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
const btnUnmuteOverlay = el<HTMLButtonElement>("btn-unmute-overlay");
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
const statAudio = el<HTMLElement>("stat-audio");
const statRtt = el<HTMLElement>("stat-rtt");
const statLoss = el<HTMLElement>("stat-loss");
const statCodec = el<HTMLElement>("stat-codec");
const statState = el<HTMLElement>("stat-state");

let activeMode: "host" | "viewer" = "host";
let isHosting = false;
let isWatching = false;
let meterRafId: number | null = null;
let currentRoomCode = "";
let currentNickname = "";
let nicknameModalRequired = false;
let pendingOnboardingAfterNickname = false;
let latestAvailableVersion = "";

function openIntroModal(): void {
  introModal.classList.remove("hidden");
  window.requestAnimationFrame(() => btnIntroClose.focus());
}

function closeIntroModal(): void {
  introModal.classList.add("hidden");
  window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "1");
}

btnOpenIntro.addEventListener("click", () => openIntroModal());
btnIntroClose.addEventListener("click", () => closeIntroModal());
introModal.addEventListener("click", (e) => {
  if (e.target === introModal) {
    closeIntroModal();
  }
});

btnDismissUpdate.addEventListener("click", () => {
  updateBanner.classList.add("hidden");
  if (latestAvailableVersion) {
    window.localStorage.setItem(DISMISSED_UPDATE_KEY, latestAvailableVersion);
  }
});

async function runStartupVersionCheck(): Promise<void> {
  const currentVersion = await getCurrentAppVersion();
  introAppVersion.textContent = `v${currentVersion}`;

  const update = await checkForAppUpdate(getSignalingUrl());
  if (!update) return;

  const dismissed = window.localStorage.getItem(DISMISSED_UPDATE_KEY);
  if (dismissed === update.latestVersion) return;

  latestAvailableVersion = update.latestVersion;
  const notes = update.releaseNotes ? ` — ${update.releaseNotes}` : "";
  updateBannerMsg.textContent = `Version v${update.latestVersion} is available (you're on v${update.currentVersion})${notes}`;

  if (update.downloadUrl) {
    updateDownloadLink.href = update.downloadUrl;
    updateDownloadLink.classList.remove("hidden");
  } else {
    updateDownloadLink.classList.add("hidden");
  }

  updateBanner.classList.remove("hidden");
}

function sanitizeNickname(raw: string): string {
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NICKNAME_LEN);
}

function setNickname(name: string): void {
  currentNickname = name;
  nicknameDisplay.textContent = name || "Set nickname";
  if (name) {
    window.localStorage.setItem(NICKNAME_STORAGE_KEY, name);
  }
}

function openNicknameModal(required: boolean): void {
  if (!required && (isHosting || isWatching)) return;
  nicknameModalRequired = required;
  nicknameModalTitle.textContent = required ? "Choose a Nickname" : "Change Nickname";
  btnNicknameCancel.classList.toggle("hidden", required);
  showAlert(nicknameError, null);
  nicknameInput.value = currentNickname;
  nicknameModal.classList.remove("hidden");
  window.requestAnimationFrame(() => {
    nicknameInput.focus();
    nicknameInput.select();
  });
}

function closeNicknameModal(): void {
  if (nicknameModalRequired && !currentNickname) return;
  nicknameModal.classList.add("hidden");
  showAlert(nicknameError, null);
}

btnEditNickname.addEventListener("click", () => openNicknameModal(false));
btnNicknameCancel.addEventListener("click", () => closeNicknameModal());
nicknameModal.addEventListener("click", (e) => {
  if (e.target === nicknameModal && !nicknameModalRequired) {
    closeNicknameModal();
  }
});

nicknameForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const cleaned = sanitizeNickname(nicknameInput.value);
  if (!cleaned) {
    showAlert(nicknameError, "Please enter a nickname (1–24 characters).");
    nicknameInput.focus();
    return;
  }
  setNickname(cleaned);
  nicknameModalRequired = false;
  closeNicknameModal();
  if (pendingOnboardingAfterNickname) {
    pendingOnboardingAfterNickname = false;
    openIntroModal();
  }
});

// Initialize persisted signaling URL
const savedUrl = window.localStorage.getItem(SIGNALING_STORAGE_KEY);
signalingInput.placeholder = DEFAULT_SIGNALING_URL;
signalingInput.value = savedUrl ? normalizeSignalingUrl(savedUrl) : DEFAULT_SIGNALING_URL;
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
  btnEditNickname.disabled = locked;
  btnEditNickname.title = locked
    ? "Leave the active room to change your nickname"
    : "Change your nickname";
}

tabHost.addEventListener("click", () => setMode("host"));
tabViewer.addEventListener("click", () => setMode("viewer"));

let detectedDiscord: DiscordProcessInfo | null = null;

function parseAudioTarget(value: string): AudioCaptureTarget {
  if (!value) return { kind: "none" };
  if (value === "exclude-discord") return { kind: "exclude_discord" };
  const pid = Number(value);
  return Number.isFinite(pid) && pid > 0 ? { kind: "include_pid", pid } : { kind: "none" };
}

function updateAudioHint(select: HTMLSelectElement, hintEl: HTMLElement): void {
  const val = select.value;
  if (val === "exclude-discord") {
    if (detectedDiscord) {
      hintEl.textContent = `Captures all PC audio (games, browser, music, etc.) while excluding ${detectedDiscord.processName} so watchers don't hear themselves or voice-call echo.`;
    } else {
      hintEl.textContent =
        "Captures all PC audio while excluding Discord so watchers don't hear themselves. (Discord isn't running right now — if you open it later, click Refresh and re-select this option.)";
    }
  } else if (val) {
    hintEl.textContent =
      "Only captures audio from the selected application and its child processes — never system notifications or voice chat.";
  } else {
    hintEl.textContent =
      'Video only — no audio sent. Choose "All PC Audio (Exclude Discord)" to share all PC sound without watchers hearing themselves, or pick a single app.';
  }
}

// Populate Windows application audio dropdowns
function populateAppSelect(
  select: HTMLSelectElement,
  apps: AudioAppInfo[],
  discord: DiscordProcessInfo | null,
  preserveValue: string
): void {
  select.innerHTML = "";

  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "No Audio (Video Only)";
  select.appendChild(noneOpt);

  const excludeDiscordOpt = document.createElement("option");
  excludeDiscordOpt.value = "exclude-discord";
  excludeDiscordOpt.textContent = discord
    ? `All PC Audio (Exclude ${discord.processName} — no voice echo)`
    : "All PC Audio (Exclude Discord — not running)";
  select.appendChild(excludeDiscordOpt);

  if (apps.length > 0) {
    const group = document.createElement("optgroup");
    group.label = "Single Application Only";

    for (const app of apps) {
      const opt = document.createElement("option");
      opt.value = String(app.pid);
      const badge = app.isPlayingAudio
        ? "[Playing] "
        : app.hasAudioSession
          ? "[Audio] "
          : "";
      const title =
        app.windowTitle.length > 46
          ? `${app.windowTitle.slice(0, 43)}...`
          : app.windowTitle;
      opt.textContent = `${badge}${app.processName} — ${title} (PID ${app.pid})`;
      group.appendChild(opt);
    }

    select.appendChild(group);
  }

  if (preserveValue && Array.from(select.options).some((o) => o.value === preserveValue)) {
    select.value = preserveValue;
  } else {
    select.value = "";
  }
}

async function refreshAudioApps(): Promise<void> {
  try {
    const [apps, discord] = await Promise.all([listAudioApps(), findDiscordApp()]);
    detectedDiscord = discord;
    populateAppSelect(audioAppSelect, apps, discord, audioAppSelect.value);
    populateAppSelect(liveAudioAppSelect, apps, discord, liveAudioAppSelect.value);
    updateAudioHint(audioAppSelect, audioAppHint);
    updateAudioHint(liveAudioAppSelect, liveAudioAppHint);
  } catch (err) {
    showAlert(hostError, `Could not enumerate Windows apps: ${String(err)}`);
  }
}

audioAppSelect.addEventListener("change", () => updateAudioHint(audioAppSelect, audioAppHint));
btnRefreshApps.addEventListener("click", () => void refreshAudioApps());
btnLiveRefreshApps.addEventListener("click", () => void refreshAudioApps());

// Audio meter & status animation loop while hosting
function startMeterLoop(): void {
  const tick = () => {
    if (!isHosting) return;
    const level = hostManager.getAudioLevel();
    hostAudioMeter.style.width = `${Math.round(level * 100)}%`;

    const status = hostManager.getAudioStatus();
    hostAudioStatus.textContent = status.label;
    hostAudioStatus.classList.toggle("status-capturing", status.state === "capturing");
    hostAudioStatus.classList.toggle("status-warn", status.state === "suspended");

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
  hostAudioStatus.textContent = "Audio off";
  hostAudioStatus.classList.remove("status-capturing", "status-warn");
}

function attachHostPreview(previewStream: MediaStream): void {
  hostPreview.srcObject = previewStream;
  hostPreview.onloadedmetadata = () => {
    hostVideoMeta.textContent = hostManager.getVideoMeta();
  };
  hostVideoMeta.textContent = hostManager.getVideoMeta();
}

function renderViewersList(viewers: ConnectedViewer[], maxViewers: number): void {
  const count = viewers.length;
  hostViewerPill.textContent = `${count} / ${maxViewers} Viewers`;
  hostViewersCount.textContent = `${count} / ${maxViewers}`;
  hostStatusText.textContent =
    count === 0
      ? "Waiting for viewers to join..."
      : `${count} ${count === 1 ? "viewer" : "viewers"} watching live.`;

  hostViewersList.innerHTML = "";
  if (count === 0) {
    const empty = document.createElement("li");
    empty.className = "viewers-empty";
    empty.textContent = "No viewers connected yet.";
    hostViewersList.appendChild(empty);
    return;
  }

  for (const viewer of viewers) {
    const li = document.createElement("li");
    li.className = "viewer-row";

    const nameSpan = document.createElement("span");
    nameSpan.className = "viewer-name";
    nameSpan.textContent = viewer.nickname;
    nameSpan.title = viewer.nickname;

    const kickBtn = document.createElement("button");
    kickBtn.type = "button";
    kickBtn.className = "btn btn-kick";
    kickBtn.textContent = "Kick";
    kickBtn.title = `Kick ${viewer.nickname} from the room`;
    kickBtn.addEventListener("click", () => {
      hostManager.kickViewer(viewer.id);
    });

    li.appendChild(nameSpan);
    li.appendChild(kickBtn);
    hostViewersList.appendChild(li);
  }
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
    renderViewersList([], maxViewers);
    hostStatusText.textContent = "Share this code with up to 5 viewers.";
    livePresetSelect.value = presetSelect.value;
    liveHintSelect.value = hintSelect.value;
    liveAudioAppSelect.value = audioAppSelect.value;
    updateAudioHint(liveAudioAppSelect, liveAudioAppHint);
    btnHostMute.textContent = "Mute Audio";
    btnHostMute.classList.remove("btn-active");
    btnHostMonitor.textContent = "Test Sound";
    btnHostMonitor.classList.remove("btn-active");

    attachHostPreview(previewStream);

    hostSetup.classList.add("hidden");
    hostLive.classList.remove("hidden");
    startMeterLoop();
  },

  onStreamChanged(previewStream) {
    attachHostPreview(previewStream);
  },

  onViewersChange(viewers, maxViewers) {
    renderViewersList(viewers, maxViewers);
  },

  onSignalingStatus(status) {
    if (status === "reconnecting") {
      hostStatusText.textContent = "Reconnecting signaling (stream still live)...";
    }
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
    btnSwitchScreen.disabled = false;
    btnSwitchScreen.textContent = "Change Screen / Window";

    if (reason) {
      showAlert(hostError, reason);
    }
  },

  onError(message) {
    showAlert(hostLiveError, message);
  },
});

btnStartShare.addEventListener("click", async () => {
  if (!currentNickname) {
    openNicknameModal(true);
    return;
  }
  showAlert(hostError, null);
  btnStartShare.disabled = true;
  btnStartShare.textContent = "Starting...";

  const audioTarget = parseAudioTarget(audioAppSelect.value);
  try {
    await hostManager.start({
      signalingUrl: getSignalingUrl(),
      nickname: currentNickname,
      preset: presetSelect.value as QualityPresetId,
      contentHint: hintSelect.value as ContentHintMode,
      audioTarget,
    });
  } catch (err) {
    btnStartShare.disabled = false;
    btnStartShare.textContent = "Pick Screen & Start Sharing";
    showAlert(hostError, err instanceof Error ? err.message : String(err));
  }
});

btnSwitchScreen.addEventListener("click", async () => {
  showAlert(hostLiveError, null);
  btnSwitchScreen.disabled = true;
  btnSwitchScreen.textContent = "Picking screen...";
  try {
    await hostManager.switchScreen();
  } catch (err) {
    showAlert(hostLiveError, err instanceof Error ? err.message : String(err));
  } finally {
    btnSwitchScreen.disabled = false;
    btnSwitchScreen.textContent = "Change Screen / Window";
  }
});

async function handleLiveQualityChange(): Promise<void> {
  showAlert(hostLiveError, null);
  const preset = livePresetSelect.value as QualityPresetId;
  const hint = liveHintSelect.value as ContentHintMode;
  presetSelect.value = preset;
  hintSelect.value = hint;
  try {
    await hostManager.updateQuality(preset, hint);
    hostVideoMeta.textContent = hostManager.getVideoMeta();
  } catch (err) {
    showAlert(hostLiveError, err instanceof Error ? err.message : String(err));
  }
}

livePresetSelect.addEventListener("change", () => void handleLiveQualityChange());
liveHintSelect.addEventListener("change", () => void handleLiveQualityChange());

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
  updateAudioHint(liveAudioAppSelect, liveAudioAppHint);
  const target = parseAudioTarget(liveAudioAppSelect.value);
  try {
    await hostManager.switchAudioTarget(target);
  } catch (err) {
    showAlert(hostLiveError, err instanceof Error ? err.message : String(err));
  }
});

btnHostMonitor.addEventListener("click", () => {
  const next = !hostManager.isMonitoringLocally();
  hostManager.setMonitorLocally(next);
  btnHostMonitor.textContent = next ? "Stop Test Sound" : "Test Sound";
  btnHostMonitor.classList.toggle("btn-active", next);
});

btnHostMute.addEventListener("click", () => {
  const nextMuted = !hostManager.isAudioMuted();
  hostManager.setAudioMuted(nextMuted);
  btnHostMute.textContent = nextMuted ? "Unmute Audio" : "Mute Audio";
  btnHostMute.classList.toggle("btn-active", nextMuted);
});

// Viewer Manager
const viewerManager = new ViewerManager({
  onJoined(code, hostNickname) {
    isWatching = true;
    setTabsLocked(true);
    showAlert(viewerError, null);
    btnUnmuteOverlay.classList.add("hidden");
    viewerRoomBadge.textContent = `Room ${code} · ${hostNickname}`;
    viewerJoin.classList.add("hidden");
    viewerStage.classList.remove("hidden");
  },

  onStream(stream) {
    if (viewerVideo.srcObject !== stream) {
      viewerVideo.srcObject = stream;
    }
    viewerVideo.muted = Number(viewerVolume.value) === 0;
    viewerVideo.volume = Number(viewerVolume.value);
    void viewerVideo.play().catch(() => {
      // Browser blocked unmuted autoplay — start muted and prompt user with one-click unmute
      viewerVideo.muted = true;
      btnViewerMute.textContent = "Unmute";
      btnUnmuteOverlay.classList.remove("hidden");
      void viewerVideo.play().catch(() => {});
    });
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
    statAudio.textContent = stats.audio;
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
    btnUnmuteOverlay.classList.add("hidden");
    viewerStage.classList.add("hidden");
    viewerJoin.classList.remove("hidden");
    btnJoinRoom.disabled = false;
    btnJoinRoom.textContent = "Join Stream";

    if (reason) {
      showAlert(viewerError, reason);
    }
  },
});

btnUnmuteOverlay.addEventListener("click", () => {
  viewerVideo.muted = false;
  if (Number(viewerVolume.value) === 0) {
    viewerVolume.value = "1";
  }
  viewerVideo.volume = Number(viewerVolume.value);
  btnViewerMute.textContent = "Mute";
  btnUnmuteOverlay.classList.add("hidden");
  void viewerVideo.play().catch(() => {});
});

// Auto-format room code input as XXXX-XXXX
roomCodeInput.addEventListener("input", () => {
  const cleaned = roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  roomCodeInput.value =
    cleaned.length > 4 ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}` : cleaned;
});

viewerJoinForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentNickname) {
    openNicknameModal(true);
    return;
  }
  showAlert(viewerError, null);

  const code = roomCodeInput.value.trim();
  if (code.length < 8) {
    showAlert(viewerError, "Enter a valid 8-character room code (e.g. ABCD-1234).");
    return;
  }

  btnJoinRoom.disabled = true;
  btnJoinRoom.textContent = "Connecting...";

  try {
    await viewerManager.join(getSignalingUrl(), code, currentNickname);
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
  if (!viewerVideo.muted) {
    btnUnmuteOverlay.classList.add("hidden");
  }
});

btnViewerMute.addEventListener("click", () => {
  viewerVideo.muted = !viewerVideo.muted;
  btnViewerMute.textContent = viewerVideo.muted ? "Unmute" : "Mute";
  if (!viewerVideo.muted) {
    btnUnmuteOverlay.classList.add("hidden");
  }
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
  if (!introModal.classList.contains("hidden")) {
    if (e.key === "Escape") {
      closeIntroModal();
    }
    return;
  }
  if (!nicknameModal.classList.contains("hidden")) {
    if (e.key === "Escape" && !nicknameModalRequired) {
      closeNicknameModal();
    }
    return;
  }
  if (!isWatching || activeMode !== "viewer") return;
  if (e.key === "i" || e.key === "I") {
    toggleStats();
  } else if (e.key === "f" || e.key === "F") {
    void toggleFullscreen();
  }
});

// Initialize persisted nickname & first-time onboarding
const savedNickname = sanitizeNickname(window.localStorage.getItem(NICKNAME_STORAGE_KEY) ?? "");
const onboardingSeen = window.localStorage.getItem(ONBOARDING_STORAGE_KEY) === "1";
if (savedNickname) {
  setNickname(savedNickname);
  if (!onboardingSeen) {
    openIntroModal();
  }
} else {
  pendingOnboardingAfterNickname = !onboardingSeen;
  openNicknameModal(true);
}

// Non-blocking startup version check against signaling server's /version endpoint
void runStartupVersionCheck();

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
