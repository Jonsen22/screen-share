import { getVersion } from "@tauri-apps/api/app";
import { isTauriRuntime } from "./audio/app-audio";
import { normalizeSignalingUrl } from "./webrtc/signaling";

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

function parseSemver(version: string): [number, number, number] | null {
  const cleaned = version.trim().replace(/^v/i, "").split("-")[0];
  const parts = cleaned.split(".");
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
}

export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
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
