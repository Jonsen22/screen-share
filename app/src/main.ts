import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  AudioAppInfo,
  AudioCaptureTarget,
  DiscordProcessInfo,
  findDiscordApp,
  isTauriRuntime,
  listAudioApps,
} from "./audio/app-audio";
import { MiniPlayerController } from "./mini-player";
import {
  getNextCorner,
  MINI_PLAYER_CORNER_LABELS,
  MiniPlayerCorner,
} from "./mini-player-geometry";
import {
  checkForAppUpdate,
  checkForNativeUpdate,
  DEFAULT_RELEASES_URL,
  formatByteSize,
  getCurrentAppVersion,
  NativeUpdate,
} from "./version-check";
import { ConnectedViewer, ContentHintMode, HostManager, QualityPresetId } from "./webrtc/host";
import { ActiveStreamInfo, normalizeSignalingUrl } from "./webrtc/signaling";
import { ViewerManager } from "./webrtc/viewer";

const SIGNALING_STORAGE_KEY = import.meta.env.DEV
  ? "screen-share.signaling-url.dev"
  : "screen-share.signaling-url";
const NICKNAME_STORAGE_KEY = "screen-share.nickname";
const ONBOARDING_STORAGE_KEY = "screen-share.onboarding-seen";
const DISMISSED_UPDATE_KEY = "screen-share.dismissed-update";
const DISCORD_WEBHOOK_STORAGE_KEY = "screen-share.discord-webhook";
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
const updateProgressWrap = el<HTMLElement>("update-progress-wrap");
const updateProgressBar = el<HTMLElement>("update-progress-bar");
const updateProgressText = el<HTMLElement>("update-progress-text");
const btnUpdateNow = el<HTMLButtonElement>("btn-update-now");
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
const btnCopyLink = el<HTMLButtonElement>("btn-copy-link");
const btnShareDiscord = el<HTMLButtonElement>("btn-share-discord");
const btnDiscordSettings = el<HTMLButtonElement>("btn-discord-settings");
const discordModal = el<HTMLElement>("discord-modal");
const discordForm = el<HTMLFormElement>("discord-form");
const discordWebhookInput = el<HTMLInputElement>("discord-webhook-input");
const discordModalError = el<HTMLElement>("discord-modal-error");
const btnDiscordCancel = el<HTMLButtonElement>("btn-discord-cancel");
const btnDiscordSave = el<HTMLButtonElement>("btn-discord-save");
const banModal = el<HTMLElement>("ban-modal");
const banModalNickname = el<HTMLElement>("ban-modal-nickname");
const btnBanCancel = el<HTMLButtonElement>("btn-ban-cancel");
const btnBanConfirm = el<HTMLButtonElement>("btn-ban-confirm");
const btnHostMonitor = el<HTMLButtonElement>("btn-host-monitor");
const btnHostMute = el<HTMLButtonElement>("btn-host-mute");
const hostPreview = el<HTMLVideoElement>("host-preview");
const hostRemoteVideo = el<HTMLVideoElement>("host-remote-video");
const hostRemoteBanner = el<HTMLElement>("host-remote-banner");
const hostRemoteBannerText = el<HTMLElement>("host-remote-banner-text");
const hostRemoteControls = el<HTMLElement>("host-remote-controls");
const hostRemoteBadge = el<HTMLElement>("host-remote-badge");
const btnHostRemoteMute = el<HTMLButtonElement>("btn-host-remote-mute");
const hostRemoteVolume = el<HTMLInputElement>("host-remote-volume");
const btnHostBackPreview = el<HTMLButtonElement>("btn-host-back-preview");
const hostStreamsList = el<HTMLElement>("host-streams-list");
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
const viewerStreamsList = el<HTMLElement>("viewer-streams-list");
const viewerShareControls = el<HTMLElement>("viewer-share-controls");
const btnViewerShare = el<HTMLButtonElement>("btn-viewer-share");
const btnViewerSwitchScreen = el<HTMLButtonElement>("btn-viewer-switch-screen");
const btnViewerShareMute = el<HTMLButtonElement>("btn-viewer-share-mute");
const viewerVideoWrap = el<HTMLElement>("viewer-video-wrap");
const viewerVideo = el<HTMLVideoElement>("viewer-video");
const viewerLocalPreview = el<HTMLVideoElement>("viewer-local-preview");
const viewerBanner = el<HTMLElement>("viewer-banner");
const viewerBannerText = el<HTMLElement>("viewer-banner-text");
const btnUnmuteOverlay = el<HTMLButtonElement>("btn-unmute-overlay");
const viewerRoomBadge = el<HTMLElement>("viewer-room-badge");
const btnViewerMute = el<HTMLButtonElement>("btn-viewer-mute");
const viewerVolume = el<HTMLInputElement>("viewer-volume");
const btnToggleStats = el<HTMLButtonElement>("btn-toggle-stats");
const btnMiniPlayer = el<HTMLButtonElement>("btn-mini-player");
const btnFullscreen = el<HTMLButtonElement>("btn-fullscreen");
const btnLeaveRoom = el<HTMLButtonElement>("btn-leave-room");
const statsHud = el<HTMLElement>("stats-hud");
const miniPlayerLabel = el<HTMLElement>("mini-player-label");
const miniPlayerAudioBar = el<HTMLElement>("mini-player-audio-bar");
const btnMiniSnap = el<HTMLButtonElement>("btn-mini-snap");
const btnMiniRestore = el<HTMLButtonElement>("btn-mini-restore");
const btnMiniMute = el<HTMLButtonElement>("btn-mini-mute");
const miniVolume = el<HTMLInputElement>("mini-volume");

// Co-stream modal elements
const costreamModal = el<HTMLElement>("costream-modal");
const costreamForm = el<HTMLFormElement>("costream-form");
const costreamPresetSelect = el<HTMLSelectElement>("costream-preset-select");
const costreamHintSelect = el<HTMLSelectElement>("costream-hint-select");
const costreamAudioAppSelect = el<HTMLSelectElement>("costream-audio-app-select");
const btnCostreamRefreshApps = el<HTMLButtonElement>("btn-costream-refresh-apps");
const costreamAudioAppHint = el<HTMLElement>("costream-audio-app-hint");
const costreamError = el<HTMLElement>("costream-error");
const btnCostreamCancel = el<HTMLButtonElement>("btn-costream-cancel");
const btnCostreamStart = el<HTMLButtonElement>("btn-costream-start");

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
let pendingNativeUpdate: NativeUpdate | null = null;
let fallbackDownloadUrl = "";
let defaultUpdateMessage = "";
let isUpdating = false;
let updateConfirmTimer: number | null = null;
let awaitingActiveSessionConfirm = false;
let lastNonZeroViewerVolume = 1;

function updateMiniPlayerUi(active: boolean, corner: MiniPlayerCorner): void {
  btnMiniPlayer.classList.toggle("btn-active", active);
  btnMiniPlayer.textContent = active ? "Exit Mini (P)" : "Mini Player (P)";
  btnMiniPlayer.setAttribute("aria-pressed", String(active));
  const nextCorner = getNextCorner(corner);
  btnMiniSnap.title = `Snap corner (${MINI_PLAYER_CORNER_LABELS[corner]} → ${MINI_PLAYER_CORNER_LABELS[nextCorner]})`;
}

const miniPlayer = new MiniPlayerController({
  videoEl: viewerVideo,
  onStateChange: updateMiniPlayerUi,
});
miniPlayer.attachDragSurface(viewerVideoWrap);
updateMiniPlayerUi(false, miniPlayer.getCorner());

if (!miniPlayer.isSupported()) {
  btnMiniPlayer.disabled = true;
  btnMiniPlayer.title =
    "Mini Player / Picture-in-Picture is not supported in this browser";
}

function openIntroModal(): void {
  void miniPlayer.exit();
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

function clearActiveSessionConfirm(restoreMessage: boolean): void {
  if (updateConfirmTimer !== null) {
    window.clearTimeout(updateConfirmTimer);
    updateConfirmTimer = null;
  }
  awaitingActiveSessionConfirm = false;
  btnUpdateNow.classList.remove("btn-danger");
  btnUpdateNow.classList.add("btn-primary");
  if (!isUpdating) {
    btnUpdateNow.textContent = updateBanner.classList.contains("is-error")
      ? "Retry Update"
      : "Update Now";
  }
  if (restoreMessage && defaultUpdateMessage && !isUpdating) {
    updateBannerMsg.textContent = defaultUpdateMessage;
  }
}

btnDismissUpdate.addEventListener("click", () => {
  if (isUpdating) return;
  clearActiveSessionConfirm(false);
  const toClose = pendingNativeUpdate;
  pendingNativeUpdate = null;
  if (toClose) {
    void toClose.close().catch(() => {});
  }
  updateBanner.classList.add("hidden");
  updateBanner.classList.remove("is-error");
  if (latestAvailableVersion) {
    window.localStorage.setItem(DISMISSED_UPDATE_KEY, latestAvailableVersion);
  }
});

updateDownloadLink.addEventListener("click", async (e) => {
  if (!fallbackDownloadUrl) {
    e.preventDefault();
    return;
  }
  if (!isTauriRuntime()) {
    return;
  }
  e.preventDefault();
  try {
    await invoke("open_external_url", { url: fallbackDownloadUrl });
  } catch (err) {
    updateBanner.classList.add("is-error");
    updateBannerMsg.textContent = `Could not open download link: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
});

btnUpdateNow.addEventListener("click", async () => {
  if (isUpdating || !pendingNativeUpdate) return;

  if ((isHosting || isWatching) && !awaitingActiveSessionConfirm) {
    awaitingActiveSessionConfirm = true;
    updateBannerMsg.textContent =
      "You are in a live session — updating will disconnect you and restart the app. Click again to confirm.";
    btnUpdateNow.textContent = "Stop & Update";
    btnUpdateNow.classList.remove("btn-primary");
    btnUpdateNow.classList.add("btn-danger");
    updateConfirmTimer = window.setTimeout(() => {
      clearActiveSessionConfirm(true);
    }, 8000);
    return;
  }

  clearActiveSessionConfirm(true);
  updateBannerMsg.textContent = defaultUpdateMessage || "Downloading update...";
  isUpdating = true;
  btnUpdateNow.disabled = true;
  btnDismissUpdate.disabled = true;
  updateDownloadLink.classList.add("hidden");
  updateBanner.classList.remove("is-error");

  try {
    await miniPlayer.exit();
    if (isHosting) {
      await hostManager.stop();
    }
    if (isWatching) {
      viewerManager.leave();
    }

    updateProgressWrap.classList.remove("hidden");
    updateProgressBar.classList.remove("indeterminate");
    updateProgressBar.style.width = "0%";
    updateProgressBar.setAttribute("aria-valuenow", "0");
    btnUpdateNow.textContent = "Updating...";
    updateProgressText.textContent = "Starting download...";

    let totalBytes: number | null = null;
    let downloadedBytes = 0;

    await pendingNativeUpdate.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started": {
          totalBytes =
            typeof event.data.contentLength === "number" && event.data.contentLength > 0
              ? event.data.contentLength
              : null;
          downloadedBytes = 0;
          updateProgressBar.classList.toggle("indeterminate", totalBytes === null);
          updateProgressBar.style.width = totalBytes === null ? "" : "0%";
          updateProgressBar.setAttribute("aria-valuenow", "0");
          updateProgressText.textContent = totalBytes
            ? `0% (0 B / ${formatByteSize(totalBytes)})`
            : "Downloading...";
          break;
        }
        case "Progress": {
          downloadedBytes += event.data.chunkLength;
          if (totalBytes) {
            const pct = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
            updateProgressBar.style.width = `${pct}%`;
            updateProgressBar.setAttribute("aria-valuenow", String(pct));
            updateProgressText.textContent = `${pct}% (${formatByteSize(downloadedBytes)} / ${formatByteSize(totalBytes)})`;
          } else {
            updateProgressText.textContent = `Downloading... (${formatByteSize(downloadedBytes)})`;
          }
          break;
        }
        case "Finished": {
          updateProgressBar.classList.remove("indeterminate");
          updateProgressBar.style.width = "100%";
          updateProgressBar.setAttribute("aria-valuenow", "100");
          updateProgressText.textContent = "100%";
          updateBannerMsg.textContent = "Update downloaded! Restarting...";
          break;
        }
      }
    });

    await relaunch();
  } catch (err) {
    isUpdating = false;
    updateProgressWrap.classList.add("hidden");
    updateProgressBar.classList.remove("indeterminate");
    updateBanner.classList.add("is-error");
    updateBannerMsg.textContent = `Update failed: ${
      err instanceof Error ? err.message : String(err)
    }`;
    btnUpdateNow.disabled = false;
    btnUpdateNow.textContent = "Retry Update";
    btnDismissUpdate.disabled = false;
    if (fallbackDownloadUrl) {
      updateDownloadLink.href = fallbackDownloadUrl;
      updateDownloadLink.classList.remove("btn-primary", "hidden");
      updateDownloadLink.classList.add("btn-secondary");
    }
  }
});

async function runStartupVersionCheck(): Promise<void> {
  const currentVersion = await getCurrentAppVersion();
  introAppVersion.textContent = `v${currentVersion}`;

  if (isTauriRuntime()) {
    const nativeUpdate = await checkForNativeUpdate();
    if (nativeUpdate) {
      const dismissed = window.localStorage.getItem(DISMISSED_UPDATE_KEY);
      if (dismissed === nativeUpdate.version) {
        void nativeUpdate.close().catch(() => {});
        return;
      }

      if (pendingNativeUpdate && pendingNativeUpdate !== nativeUpdate) {
        void pendingNativeUpdate.close().catch(() => {});
      }
      pendingNativeUpdate = nativeUpdate;
      latestAvailableVersion = nativeUpdate.version;
      fallbackDownloadUrl = DEFAULT_RELEASES_URL;

      const firstLine = (nativeUpdate.body ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      const notes = firstLine ? ` — ${firstLine.slice(0, 120)}` : "";
      defaultUpdateMessage = `Version v${nativeUpdate.version} is available (you're on v${currentVersion})${notes}`;
      updateBannerMsg.textContent = defaultUpdateMessage;

      updateBanner.classList.remove("is-error");
      btnUpdateNow.textContent = "Update Now";
      btnUpdateNow.disabled = false;
      btnUpdateNow.classList.remove("btn-danger", "hidden");
      btnUpdateNow.classList.add("btn-primary");

      updateDownloadLink.href = fallbackDownloadUrl;
      updateDownloadLink.classList.add("hidden");
      updateProgressWrap.classList.add("hidden");
      updateBanner.classList.remove("hidden");
      return;
    }
  }

  const update = await checkForAppUpdate(getSignalingUrl());
  if (!update) return;

  const dismissed = window.localStorage.getItem(DISMISSED_UPDATE_KEY);
  if (dismissed === update.latestVersion) return;

  latestAvailableVersion = update.latestVersion;
  fallbackDownloadUrl = update.downloadUrl || "";
  const notes = update.releaseNotes ? ` — ${update.releaseNotes}` : "";
  defaultUpdateMessage = `Version v${update.latestVersion} is available (you're on v${update.currentVersion})${notes}`;
  updateBannerMsg.textContent = defaultUpdateMessage;

  updateBanner.classList.remove("is-error");
  btnUpdateNow.classList.add("hidden");
  updateProgressWrap.classList.add("hidden");

  if (fallbackDownloadUrl) {
    updateDownloadLink.href = fallbackDownloadUrl;
    updateDownloadLink.classList.remove("btn-secondary", "hidden");
    updateDownloadLink.classList.add("btn-primary");
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
  void miniPlayer.exit();
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

let pendingDeepLinkCode: string | null = null;

function buildJoinUrl(code: string): string {
  const wsUrl = getSignalingUrl();
  if (wsUrl.startsWith("wss://")) {
    return `https://${wsUrl.slice("wss://".length)}/join/${encodeURIComponent(code)}`;
  }
  if (wsUrl.startsWith("ws://")) {
    return `http://${wsUrl.slice("ws://".length)}/join/${encodeURIComponent(code)}`;
  }
  return `screenshare://join/${encodeURIComponent(code)}`;
}

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
  if (pendingDeepLinkCode) {
    const codeToJoin = pendingDeepLinkCode;
    pendingDeepLinkCode = null;
    pendingOnboardingAfterNickname = false;
    void triggerDeepLinkJoin(codeToJoin);
  } else if (pendingOnboardingAfterNickname) {
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
  void miniPlayer.exit();
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
    populateAppSelect(costreamAudioAppSelect, apps, discord, costreamAudioAppSelect.value);
    updateAudioHint(audioAppSelect, audioAppHint);
    updateAudioHint(liveAudioAppSelect, liveAudioAppHint);
    updateAudioHint(costreamAudioAppSelect, costreamAudioAppHint);
  } catch (err) {
    showAlert(hostError, `Could not enumerate Windows apps: ${String(err)}`);
  }
}

audioAppSelect.addEventListener("change", () => updateAudioHint(audioAppSelect, audioAppHint));
costreamAudioAppSelect.addEventListener("change", () =>
  updateAudioHint(costreamAudioAppSelect, costreamAudioAppHint)
);
btnRefreshApps.addEventListener("click", () => void refreshAudioApps());
btnLiveRefreshApps.addEventListener("click", () => void refreshAudioApps());
btnCostreamRefreshApps.addEventListener("click", () => void refreshAudioApps());

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

let pendingBanViewer: ConnectedViewer | null = null;

function openBanModal(viewer: ConnectedViewer): void {
  pendingBanViewer = viewer;
  banModalNickname.textContent = viewer.nickname;
  banModal.classList.remove("hidden");
  window.requestAnimationFrame(() => btnBanCancel.focus());
}

function closeBanModal(): void {
  pendingBanViewer = null;
  banModal.classList.add("hidden");
}

btnBanCancel.addEventListener("click", () => closeBanModal());
banModal.addEventListener("click", (e) => {
  if (e.target === banModal) {
    closeBanModal();
  }
});
btnBanConfirm.addEventListener("click", () => {
  const target = pendingBanViewer;
  closeBanModal();
  if (target) {
    hostManager.banViewer(target.id);
  }
});

function renderViewersList(viewers: ConnectedViewer[], maxViewers: number): void {
  if (pendingBanViewer && !viewers.some((v) => v.id === pendingBanViewer?.id)) {
    closeBanModal();
  }

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

    const actionsDiv = document.createElement("div");
    actionsDiv.className = "viewer-actions";

    const kickBtn = document.createElement("button");
    kickBtn.type = "button";
    kickBtn.className = "btn btn-kick";
    kickBtn.textContent = "Kick";
    kickBtn.title = `Kick ${viewer.nickname} from the room`;
    kickBtn.addEventListener("click", () => {
      hostManager.kickViewer(viewer.id);
    });

    const banBtn = document.createElement("button");
    banBtn.type = "button";
    banBtn.className = "btn btn-ban";
    banBtn.textContent = "Ban";
    banBtn.title = `Ban ${viewer.nickname} from this room session`;
    banBtn.addEventListener("click", () => {
      openBanModal(viewer);
    });

    actionsDiv.appendChild(kickBtn);
    actionsDiv.appendChild(banBtn);

    li.appendChild(nameSpan);
    li.appendChild(actionsDiv);
    hostViewersList.appendChild(li);
  }
}

function renderHostStreamsBar(
  streams: ActiveStreamInfo[],
  watchedStreamerId: string | null
): void {
  hostStreamsList.innerHTML = "";

  const selfBtn = document.createElement("button");
  selfBtn.type = "button";
  selfBtn.role = "tab";
  const viewingSelf = !watchedStreamerId;
  selfBtn.className = `stream-pill is-self${viewingSelf ? " active" : ""}`;
  selfBtn.setAttribute("aria-selected", String(viewingSelf));
  const selfDot = document.createElement("span");
  selfDot.className = "stream-pill-dot";
  selfBtn.appendChild(selfDot);
  selfBtn.appendChild(document.createTextNode("Your Stream (Preview)"));
  selfBtn.addEventListener("click", () => {
    hostManager.stopWatching(true);
  });
  hostStreamsList.appendChild(selfBtn);

  for (const stream of streams) {
    if (stream.streamerId === "host") continue;
    const isActive = watchedStreamerId === stream.streamerId;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.role = "tab";
    btn.className = `stream-pill${isActive ? " active" : ""}`;
    btn.setAttribute("aria-selected", String(isActive));
    const dot = document.createElement("span");
    dot.className = "stream-pill-dot";
    btn.appendChild(dot);
    btn.appendChild(document.createTextNode(stream.nickname));
    btn.addEventListener("click", () => {
      hostManager.watchStream(stream.streamerId);
    });
    hostStreamsList.appendChild(btn);
  }

  if (viewingSelf) {
    hostRemoteVideo.classList.add("hidden");
    hostRemoteControls.classList.add("hidden");
    hostRemoteBanner.classList.add("hidden");
    hostPreview.classList.remove("hidden");
  } else {
    const watched = streams.find((s) => s.streamerId === watchedStreamerId);
    hostRemoteBadge.textContent = watched ? `Watching ${watched.nickname}` : "Watching co-streamer";
    hostPreview.classList.add("hidden");
    hostRemoteVideo.classList.remove("hidden");
    hostRemoteControls.classList.remove("hidden");
  }
}

btnHostBackPreview.addEventListener("click", () => {
  hostManager.stopWatching(true);
});

hostRemoteVolume.addEventListener("input", () => {
  const vol = Number(hostRemoteVolume.value);
  hostRemoteVideo.volume = vol;
  hostRemoteVideo.muted = vol === 0;
  btnHostRemoteMute.textContent = hostRemoteVideo.muted ? "Unmute" : "Mute";
});

btnHostRemoteMute.addEventListener("click", () => {
  hostRemoteVideo.muted = !hostRemoteVideo.muted;
  btnHostRemoteMute.textContent = hostRemoteVideo.muted ? "Unmute" : "Mute";
});

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
    hostRemoteVideo.srcObject = null;
    hostRemoteVideo.classList.add("hidden");
    hostRemoteControls.classList.add("hidden");
    hostRemoteBanner.classList.add("hidden");
    hostPreview.classList.remove("hidden");

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

  onActiveStreamsChange(streams, watchedStreamerId) {
    renderHostStreamsBar(streams, watchedStreamerId);
  },

  onRemoteStream(stream) {
    if (!stream) {
      hostRemoteVideo.srcObject = null;
      return;
    }
    if (hostRemoteVideo.srcObject !== stream) {
      hostRemoteVideo.srcObject = stream;
    }
    hostRemoteVideo.volume = Number(hostRemoteVolume.value);
    hostRemoteVideo.muted = Number(hostRemoteVolume.value) === 0;
    btnHostRemoteMute.textContent = hostRemoteVideo.muted ? "Unmute" : "Mute";
    void hostRemoteVideo.play().catch(() => {
      hostRemoteVideo.muted = true;
      btnHostRemoteMute.textContent = "Unmute";
      void hostRemoteVideo.play().catch(() => {});
    });
  },

  onRemoteBanner(text) {
    if (!text) {
      hostRemoteBanner.classList.add("hidden");
    } else {
      hostRemoteBannerText.textContent = text;
      hostRemoteBanner.classList.remove("hidden");
    }
  },

  onSignalingStatus(status) {
    if (status === "reconnecting") {
      hostStatusText.textContent = "Reconnecting signaling (stream still live)...";
    }
  },

  onEnded(reason) {
    isHosting = false;
    currentRoomCode = "";
    closeBanModal();
    stopMeterLoop();
    setTabsLocked(false);

    hostPreview.srcObject = null;
    hostRemoteVideo.srcObject = null;
    hostRemoteVideo.classList.add("hidden");
    hostRemoteControls.classList.add("hidden");
    hostRemoteBanner.classList.add("hidden");
    hostPreview.classList.remove("hidden");
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

btnCopyLink.addEventListener("click", async () => {
  if (!currentRoomCode) return;
  const url = buildJoinUrl(currentRoomCode);
  try {
    await navigator.clipboard.writeText(url);
    btnCopyLink.textContent = "Link Copied!";
    window.setTimeout(() => {
      btnCopyLink.textContent = "Copy Link";
    }, 1500);
  } catch {
    btnCopyLink.textContent = "Copy Failed";
  }
});

let shareAfterWebhookSave = false;

function getSavedDiscordWebhook(): string {
  return (window.localStorage.getItem(DISCORD_WEBHOOK_STORAGE_KEY) || "").trim();
}

function openDiscordModal(autoShareOnSave: boolean): void {
  shareAfterWebhookSave = autoShareOnSave;
  discordWebhookInput.value = getSavedDiscordWebhook();
  showAlert(discordModalError, null);
  btnDiscordSave.textContent = autoShareOnSave ? "Save & Share" : "Save Webhook";
  discordModal.classList.remove("hidden");
  discordWebhookInput.focus();
  discordWebhookInput.select();
}

function closeDiscordModal(): void {
  discordModal.classList.add("hidden");
  showAlert(discordModalError, null);
}

async function postRoomToDiscord(webhookUrl: string): Promise<void> {
  if (!currentRoomCode) return;
  showAlert(hostLiveError, null);
  if (!isTauriRuntime()) {
    showAlert(hostLiveError, "Sharing to Discord requires the Windows desktop app.");
    return;
  }

  btnShareDiscord.disabled = true;
  btnShareDiscord.textContent = "Posting...";
  try {
    const joinUrl = buildJoinUrl(currentRoomCode);
    const qualityLabel = livePresetSelect.selectedOptions[0]?.textContent || "1080p · 30 fps";
    await invoke("send_discord_webhook", {
      webhookUrl,
      hostNickname: currentNickname || "Host",
      roomCode: currentRoomCode,
      joinUrl,
      quality: qualityLabel,
    });
    btnShareDiscord.textContent = "Shared to Discord!";
    window.setTimeout(() => {
      btnShareDiscord.textContent = "Share to Discord";
      btnShareDiscord.disabled = false;
    }, 2200);
  } catch (err) {
    btnShareDiscord.textContent = "Share to Discord";
    btnShareDiscord.disabled = false;
    showAlert(hostLiveError, err instanceof Error ? err.message : String(err));
  }
}

btnShareDiscord.addEventListener("click", () => {
  const saved = getSavedDiscordWebhook();
  if (!saved) {
    openDiscordModal(true);
    return;
  }
  void postRoomToDiscord(saved);
});

btnDiscordSettings.addEventListener("click", () => {
  openDiscordModal(false);
});

btnDiscordCancel.addEventListener("click", () => closeDiscordModal());
discordModal.addEventListener("click", (e) => {
  if (e.target === discordModal) {
    closeDiscordModal();
  }
});

discordForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = discordWebhookInput.value.trim();
  if (!raw) {
    window.localStorage.removeItem(DISCORD_WEBHOOK_STORAGE_KEY);
    closeDiscordModal();
    return;
  }
  if (!/^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\//i.test(raw)) {
    showAlert(
      discordModalError,
      "Enter a valid Discord webhook URL (https://discord.com/api/webhooks/...)."
    );
    discordWebhookInput.focus();
    return;
  }
  window.localStorage.setItem(DISCORD_WEBHOOK_STORAGE_KEY, raw);
  const shouldShare = shareAfterWebhookSave;
  closeDiscordModal();
  if (shouldShare && currentRoomCode) {
    void postRoomToDiscord(raw);
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

let viewerJoinedCode = "";

function openCostreamModal(): void {
  if (!isWatching) return;
  void miniPlayer.exit();
  showAlert(costreamError, null);
  btnCostreamStart.disabled = false;
  btnCostreamStart.textContent = "Pick Screen & Share";
  if (isTauriRuntime()) {
    void refreshAudioApps();
  }
  costreamModal.classList.remove("hidden");
  window.requestAnimationFrame(() => btnCostreamStart.focus());
}

function closeCostreamModal(): void {
  costreamModal.classList.add("hidden");
  showAlert(costreamError, null);
}

btnCostreamCancel.addEventListener("click", () => closeCostreamModal());
costreamModal.addEventListener("click", (e) => {
  if (e.target === costreamModal) {
    closeCostreamModal();
  }
});

costreamForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  showAlert(costreamError, null);
  btnCostreamStart.disabled = true;
  btnCostreamStart.textContent = "Starting...";

  const audioTarget = parseAudioTarget(costreamAudioAppSelect.value);
  try {
    await viewerManager.startSharing({
      preset: costreamPresetSelect.value as QualityPresetId,
      contentHint: costreamHintSelect.value as ContentHintMode,
      audioTarget,
    });
    closeCostreamModal();
  } catch (err) {
    btnCostreamStart.disabled = false;
    btnCostreamStart.textContent = "Pick Screen & Share";
    showAlert(costreamError, err instanceof Error ? err.message : String(err));
  }
});

btnViewerShare.addEventListener("click", () => {
  if (!isWatching) return;
  if (viewerManager.isSharing()) {
    void viewerManager.stopSharing();
  } else {
    openCostreamModal();
  }
});

btnViewerSwitchScreen.addEventListener("click", async () => {
  if (!viewerManager.isSharing()) return;
  btnViewerSwitchScreen.disabled = true;
  btnViewerSwitchScreen.textContent = "Picking...";
  try {
    await viewerManager.switchSharedScreen();
  } catch (err) {
    viewerBannerText.textContent = err instanceof Error ? err.message : String(err);
    viewerBanner.classList.remove("hidden");
  } finally {
    btnViewerSwitchScreen.disabled = false;
    btnViewerSwitchScreen.textContent = "Change Screen";
  }
});

btnViewerShareMute.addEventListener("click", () => {
  const nextMuted = !viewerManager.isSharedAudioMuted();
  viewerManager.setSharedAudioMuted(nextMuted);
  btnViewerShareMute.textContent = nextMuted ? "Unmute Shared Audio" : "Mute Shared Audio";
  btnViewerShareMute.classList.toggle("btn-active", nextMuted);
});

function renderViewerStreamsBar(
  streams: ActiveStreamInfo[],
  watchedStreamerId: string | null,
  selfId: string
): void {
  viewerStreamsList.innerHTML = "";
  if (streams.length === 0) {
    const empty = document.createElement("span");
    empty.className = "muted small";
    empty.textContent = "No active streams";
    viewerStreamsList.appendChild(empty);
  } else {
    for (const stream of streams) {
      const isSelf = stream.streamerId === selfId;
      const isActive = watchedStreamerId === stream.streamerId;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.role = "tab";
      btn.className = `stream-pill${isSelf ? " is-self" : ""}${isActive ? " active" : ""}`;
      btn.setAttribute("aria-selected", String(isActive));
      const dot = document.createElement("span");
      dot.className = "stream-pill-dot";
      btn.appendChild(dot);
      btn.appendChild(
        document.createTextNode(isSelf ? "Your Stream (Preview)" : stream.nickname)
      );
      btn.addEventListener("click", () => {
        viewerManager.watchStream(stream.streamerId);
      });
      viewerStreamsList.appendChild(btn);
    }
  }

  const viewingSelf = Boolean(selfId && watchedStreamerId === selfId);
  if (viewingSelf) {
    viewerVideo.classList.add("hidden");
    viewerLocalPreview.classList.remove("hidden");
    btnUnmuteOverlay.classList.add("hidden");
    viewerRoomBadge.textContent = `Room ${viewerJoinedCode} · Your Preview (Muted)`;
    miniPlayerLabel.textContent = "Your Preview";
    miniPlayerAudioBar.classList.add("hidden");
    btnMiniMute.disabled = true;
    miniVolume.disabled = true;
  } else {
    viewerLocalPreview.classList.add("hidden");
    viewerVideo.classList.remove("hidden");
    const activeStream = streams.find((s) => s.streamerId === watchedStreamerId);
    viewerRoomBadge.textContent = activeStream
      ? `Room ${viewerJoinedCode} · ${activeStream.nickname}`
      : `Room ${viewerJoinedCode}`;
    miniPlayerLabel.textContent = activeStream
      ? activeStream.nickname
      : `Room ${viewerJoinedCode}`;
    miniPlayerAudioBar.classList.remove("hidden");
    btnMiniMute.disabled = false;
    miniVolume.disabled = false;
  }
}

function syncViewerAudioUi(): void {
  const volStr = String(viewerVideo.volume);
  viewerVolume.value = volStr;
  miniVolume.value = volStr;
  const muted = viewerVideo.muted || viewerVideo.volume === 0;
  const label = muted ? "Unmute" : "Mute";
  btnViewerMute.textContent = label;
  btnMiniMute.textContent = label;
  btnMiniMute.setAttribute("aria-label", muted ? "Unmute stream" : "Mute stream");
  if (!muted) {
    btnUnmuteOverlay.classList.add("hidden");
  }
}

function applyViewerVolume(rawVol: number): void {
  const vol = Number.isFinite(rawVol) ? Math.min(1, Math.max(0, rawVol)) : 1;
  if (vol > 0) {
    lastNonZeroViewerVolume = vol;
  }
  viewerVideo.volume = vol;
  viewerVideo.muted = vol === 0;
  syncViewerAudioUi();
}

function toggleViewerMute(): void {
  if (viewerVideo.muted || viewerVideo.volume === 0) {
    const restored = lastNonZeroViewerVolume > 0 ? lastNonZeroViewerVolume : 1;
    viewerVideo.volume = restored;
    viewerVideo.muted = false;
  } else {
    if (viewerVideo.volume > 0) {
      lastNonZeroViewerVolume = viewerVideo.volume;
    }
    viewerVideo.muted = true;
  }
  syncViewerAudioUi();
}

// Viewer Manager
const viewerManager = new ViewerManager({
  onJoined(code, hostNickname) {
    isWatching = true;
    viewerJoinedCode = code;
    setTabsLocked(true);
    showAlert(viewerError, null);
    btnUnmuteOverlay.classList.add("hidden");
    viewerLocalPreview.srcObject = null;
    viewerLocalPreview.classList.add("hidden");
    viewerVideo.classList.remove("hidden");
    viewerShareControls.classList.add("hidden");
    btnViewerShare.textContent = "Share My Screen";
    btnViewerShare.classList.remove("btn-danger");
    btnViewerShare.classList.add("btn-primary");
    btnViewerShareMute.textContent = "Mute Shared Audio";
    btnViewerShareMute.classList.remove("btn-active");
    viewerRoomBadge.textContent = `Room ${code} · ${hostNickname}`;
    miniPlayerLabel.textContent = hostNickname || `Room ${code}`;
    miniPlayerAudioBar.classList.remove("hidden");
    btnMiniMute.disabled = false;
    miniVolume.disabled = false;
    syncViewerAudioUi();
    viewerJoin.classList.add("hidden");
    viewerStage.classList.remove("hidden");
  },

  onStream(stream) {
    if (!stream) {
      viewerVideo.srcObject = null;
      btnUnmuteOverlay.classList.add("hidden");
      return;
    }
    if (viewerVideo.srcObject !== stream) {
      viewerVideo.srcObject = stream;
    }
    const targetVol = Number(viewerVolume.value);
    if (targetVol > 0) {
      lastNonZeroViewerVolume = targetVol;
    }
    viewerVideo.volume = targetVol;
    viewerVideo.muted = targetVol === 0;
    syncViewerAudioUi();
    void viewerVideo.play().catch(() => {
      // Browser blocked unmuted autoplay — start muted and prompt user with one-click unmute
      viewerVideo.muted = true;
      syncViewerAudioUi();
      btnUnmuteOverlay.classList.remove("hidden");
      void viewerVideo.play().catch(() => {});
    });
  },

  onLocalPreviewChange(stream, sharing) {
    viewerLocalPreview.srcObject = stream;
    viewerShareControls.classList.toggle("hidden", !sharing);
    if (sharing) {
      btnViewerShare.textContent = "Stop Sharing";
      btnViewerShare.classList.remove("btn-primary");
      btnViewerShare.classList.add("btn-danger");
    } else {
      btnViewerShare.textContent = "Share My Screen";
      btnViewerShare.classList.remove("btn-danger");
      btnViewerShare.classList.add("btn-primary");
      btnViewerShareMute.textContent = "Mute Shared Audio";
      btnViewerShareMute.classList.remove("btn-active");
    }
  },

  onActiveStreamsChange(streams, watchedStreamerId, selfId) {
    renderViewerStreamsBar(streams, watchedStreamerId, selfId);
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

  onShareError(message) {
    viewerBannerText.textContent = message;
    viewerBanner.classList.remove("hidden");
  },

  onEnded(reason) {
    isWatching = false;
    viewerJoinedCode = "";
    void miniPlayer.exit();
    closeCostreamModal();
    setTabsLocked(false);

    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    }
    viewerVideo.srcObject = null;
    viewerLocalPreview.srcObject = null;
    viewerLocalPreview.classList.add("hidden");
    viewerVideo.classList.remove("hidden");
    viewerShareControls.classList.add("hidden");
    btnViewerShare.textContent = "Share My Screen";
    btnViewerShare.classList.remove("btn-danger");
    btnViewerShare.classList.add("btn-primary");
    btnViewerShareMute.textContent = "Mute Shared Audio";
    btnViewerShareMute.classList.remove("btn-active");
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
  const restored =
    Number(viewerVolume.value) > 0
      ? Number(viewerVolume.value)
      : lastNonZeroViewerVolume > 0
        ? lastNonZeroViewerVolume
        : 1;
  lastNonZeroViewerVolume = restored;
  viewerVideo.volume = restored;
  viewerVideo.muted = false;
  syncViewerAudioUi();
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
  void miniPlayer.exit();
  viewerManager.leave();
});

viewerVolume.addEventListener("input", () => {
  applyViewerVolume(Number(viewerVolume.value));
});

miniVolume.addEventListener("input", () => {
  applyViewerVolume(Number(miniVolume.value));
});

btnViewerMute.addEventListener("click", () => {
  toggleViewerMute();
});

btnMiniMute.addEventListener("click", () => {
  toggleViewerMute();
});

function toggleStats(): void {
  statsHud.classList.toggle("hidden");
}

async function toggleFullscreen(): Promise<void> {
  if (document.fullscreenElement) {
    await document.exitFullscreen().catch(() => {});
  } else {
    await miniPlayer.exit();
    await viewerVideoWrap.requestFullscreen().catch(() => {});
  }
}

function handleViewerSurfaceDblClick(): void {
  if (miniPlayer.isEngaged()) {
    void miniPlayer.exit();
  } else {
    void toggleFullscreen();
  }
}

btnToggleStats.addEventListener("click", toggleStats);
btnMiniPlayer.addEventListener("click", () => {
  if (!isWatching || activeMode !== "viewer") return;
  void miniPlayer.toggle();
});
btnMiniSnap.addEventListener("click", () => {
  void miniPlayer.snapNextCorner();
});
btnMiniRestore.addEventListener("click", () => {
  void miniPlayer.exit();
});
btnFullscreen.addEventListener("click", () => void toggleFullscreen());
viewerVideo.addEventListener("dblclick", handleViewerSurfaceDblClick);
viewerLocalPreview.addEventListener("dblclick", handleViewerSurfaceDblClick);

window.addEventListener("beforeunload", () => {
  miniPlayer.cleanupOnUnload();
});

function isTypingElement(target: EventTarget | null, allowRange: boolean): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    if (allowRange && (target as HTMLInputElement).type === "range") {
      return false;
    }
    return true;
  }
  return false;
}

window.addEventListener("keydown", (e) => {
  if (!costreamModal.classList.contains("hidden")) {
    if (e.key === "Escape") {
      closeCostreamModal();
    }
    return;
  }
  if (!banModal.classList.contains("hidden")) {
    if (e.key === "Escape") {
      closeBanModal();
    }
    return;
  }
  if (!discordModal.classList.contains("hidden")) {
    if (e.key === "Escape") {
      closeDiscordModal();
    }
    return;
  }
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
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (miniPlayer.isEngaged()) {
    if (e.key === "Escape" && !isTypingElement(e.target, true)) {
      e.preventDefault();
      void miniPlayer.exit();
      return;
    }
    if (isTypingElement(e.target, false)) return;
    if (e.key === "p" || e.key === "P") {
      e.preventDefault();
      void miniPlayer.toggle();
    } else if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      void toggleFullscreen();
    }
    return;
  }

  if (isTypingElement(e.target, false)) return;
  if (e.key === "i" || e.key === "I") {
    toggleStats();
  } else if (e.key === "f" || e.key === "F") {
    void toggleFullscreen();
  } else if ((e.key === "p" || e.key === "P") && miniPlayer.isSupported()) {
    e.preventDefault();
    void miniPlayer.enter();
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

async function triggerDeepLinkJoin(code: string): Promise<void> {
  if (isHosting || isWatching) return;
  closeIntroModal();
  setMode("viewer");
  roomCodeInput.value = code;
  if (!currentNickname) {
    pendingDeepLinkCode = code;
    openNicknameModal(true);
    return;
  }
  viewerJoinForm.requestSubmit();
}

// Initial app enumeration & deep-link check (in Tauri desktop runtime)
if (isTauriRuntime()) {
  void refreshAudioApps();
  void invoke<string | null>("take_pending_join_code")
    .then((code) => {
      if (code) {
        void triggerDeepLinkJoin(code);
      }
    })
    .catch(() => {});
} else {
  const hint = document.createElement("option");
  hint.value = "";
  hint.textContent = "(Run in Tauri desktop app for per-app WASAPI audio)";
  hint.disabled = true;
  audioAppSelect.appendChild(hint);
}
