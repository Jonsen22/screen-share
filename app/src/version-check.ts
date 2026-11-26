import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { isTauriRuntime } from "./audio/app-audio";
import { compareSemver } from "./release-notes";
import { normalizeSignalingUrl } from "./webrtc/signaling";

export const DEFAULT_RELEASES_URL =
  "https://github.com/Jonsen22/screen-share/releases/latest";

export type NativeUpdate = Update;

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  downloadUrl: string;
  releaseNotes: string;
}

interface VersionEndpointResponse {
  latestVersion?: unknown;
  downloadUrl?: unknown;
  releaseNotes?: unknown;
}

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function checkForNativeUpdate(): Promise<NativeUpdate | null> {
  if (!isTauriRuntime()) return null;

  try {
    const update = await check();
    if (!update) return null;

    const currentVersion = await getCurrentAppVersion();
    if (update.version && !isNewerVersion(update.version, currentVersion)) {
      void update.close().catch(() => {});
      return null;
    }

    return update;
  } catch {
    // Non-fatal: ignore 404 (latest.json not yet published), offline, or dev-mode errors
    return null;
  }
}

export async function getCurrentAppVersion(): Promise<string> {
  if (isTauriRuntime()) {
    try {
      return await getVersion();
    } catch {
      // Fall back to build-time version
    }
  }
  return __APP_VERSION__;
}

export function isNewerVersion(latest: string, current: string): boolean {
  const cmp = compareSemver(latest, current);
  return cmp !== null && cmp > 0;
}

function signalingToHttpBase(signalingUrl: string): string | null {
  const normalized = normalizeSignalingUrl(signalingUrl);
  if (normalized.startsWith("wss://")) {
    return "https://" + normalized.slice("wss://".length);
  }
  if (normalized.startsWith("ws://")) {
    return "http://" + normalized.slice("ws://".length);
  }
  return null;
}

function isSafeHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export async function checkForAppUpdate(signalingUrl: string): Promise<UpdateInfo | null> {
  const base = signalingToHttpBase(signalingUrl);
  if (!base) return null;

  const currentVersion = await getCurrentAppVersion();
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch(`${base}/version`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const data = (await res.json()) as VersionEndpointResponse;
    const latestVersion = typeof data.latestVersion === "string" ? data.latestVersion.trim() : "";
    const downloadUrl = typeof data.downloadUrl === "string" ? data.downloadUrl.trim() : "";
    const releaseNotes = typeof data.releaseNotes === "string" ? data.releaseNotes.trim() : "";

    if (!latestVersion || !isNewerVersion(latestVersion, currentVersion)) {
      return null;
    }

    return {
      currentVersion,
      latestVersion,
      downloadUrl: isSafeHttpUrl(downloadUrl) ? downloadUrl : "",
      releaseNotes,
    };
  } catch {
    // Non-fatal: ignore offline/cold-start errors on startup check
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}
