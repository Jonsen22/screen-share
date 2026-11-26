import { LogicalSize, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { currentMonitor, getCurrentWindow, primaryMonitor } from "@tauri-apps/api/window";
import { isTauriRuntime } from "./audio/app-audio";
import {
  computeCornerPosition,
  getNextCorner,
  MINI_WINDOW_DEFAULT_SIZE,
  MINI_WINDOW_MIN_SIZE,
  MiniPlayerCorner,
  NORMAL_WINDOW_MIN_SIZE,
} from "./mini-player-geometry";

export interface MiniPlayerControllerOptions {
  videoEl: HTMLVideoElement;
  onStateChange?: (active: boolean, corner: MiniPlayerCorner) => void;
}

interface SavedWindowGeometry {
  innerSize: PhysicalSize;
  outerPosition: PhysicalPosition;
  wasMaximized: boolean;
}

type MiniPlayerMode = "none" | "tauri" | "browser-pip";

const DRAG_THRESHOLD_PX = 4;

export class MiniPlayerController {
  private readonly videoEl: HTMLVideoElement;
  private readonly onStateChange?: (active: boolean, corner: MiniPlayerCorner) => void;

  private active = false;
  private mode: MiniPlayerMode = "none";
  private corner: MiniPlayerCorner = "bottom-right";
  private savedGeometry: SavedWindowGeometry | null = null;
  private transitionPromise: Promise<void> = Promise.resolve();
  private entering = false;
  private transitioning = false;

  constructor(options: MiniPlayerControllerOptions) {
    this.videoEl = options.videoEl;
    this.onStateChange = options.onStateChange;

    this.videoEl.addEventListener("enterpictureinpicture", () => {
      if (isTauriRuntime()) return;
      this.active = true;
      this.mode = "browser-pip";
      this.notifyStateChange();
    });

    this.videoEl.addEventListener("leavepictureinpicture", () => {
      if (this.mode !== "browser-pip") return;
      this.active = false;
      this.mode = "none";
      this.notifyStateChange();
    });
  }

  public isSupported(): boolean {
    if (isTauriRuntime()) return true;
    return Boolean(
      typeof document !== "undefined" &&
        document.pictureInPictureEnabled &&
        typeof this.videoEl.requestPictureInPicture === "function"
    );
  }

  public isActive(): boolean {
    return this.active;
  }

  public isEngaged(): boolean {
    return this.active || this.entering;
  }

  public isTauriActive(): boolean {
    return this.active && this.mode === "tauri";
  }

  public getCorner(): MiniPlayerCorner {
    return this.corner;
  }

  public enter(): Promise<void> {
    if (this.active || this.entering || !this.isSupported()) {
      return this.transitionPromise;
    }

    this.entering = true;
    this.transitionPromise = this.transitionPromise
      .catch(() => {})
      .then(async () => {
        this.transitioning = true;
        try {
          if (this.active) return;
          if (isTauriRuntime()) {
            await this.enterTauri();
          } else {
            await this.enterBrowserPip();
          }
        } finally {
          this.entering = false;
          this.transitioning = false;
        }
      });

    return this.transitionPromise;
  }

  public exit(): Promise<void> {
    const hasBrowserPip =
      typeof document !== "undefined" &&
      document.pictureInPictureElement === this.videoEl;
    if (
      !this.active &&
      !this.entering &&
      !this.transitioning &&
      !hasBrowserPip &&
      !document.body.classList.contains("mini-player")
    ) {
      return Promise.resolve();
    }

    this.transitionPromise = this.transitionPromise
      .catch(() => {})
      .then(async () => {
        this.transitioning = true;
        try {
          if (this.mode === "tauri" || document.body.classList.contains("mini-player")) {
            await this.exitTauri();
          } else if (
            this.mode === "browser-pip" ||
            document.pictureInPictureElement === this.videoEl
          ) {
            await this.exitBrowserPip();
          } else if (this.active) {
            this.active = false;
            this.mode = "none";
            this.notifyStateChange();
          }
        } finally {
          this.transitioning = false;
        }
      });

    return this.transitionPromise;
  }

  public toggle(): Promise<void> {
    if (this.isEngaged()) {
      return this.exit();
    }
    return this.enter();
  }

  public snapNextCorner(): Promise<void> {
    if (!this.active || this.mode !== "tauri" || this.transitioning) {
      return Promise.resolve();
    }

    this.transitionPromise = this.transitionPromise
      .catch(() => {})
      .then(async () => {
        if (!this.active || this.mode !== "tauri") return;
        this.transitioning = true;
        try {
          const nextCorner = getNextCorner(this.corner);
          await this.applyCornerSnap(nextCorner);
          this.corner = nextCorner;
          this.notifyStateChange();
        } catch {
          // best-effort corner snap
        } finally {
          this.transitioning = false;
        }
      });

    return this.transitionPromise;
  }

  public attachDragSurface(container: HTMLElement): () => void {
    let pendingDrag: { startX: number; startY: number } | null = null;

    const onMouseDown = (e: MouseEvent): void => {
      if (e.button !== 0 || !this.isTauriActive() || e.detail !== 1) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("button, input, a, select, label, [data-no-drag]")) {
        return;
      }
      pendingDrag = { startX: e.clientX, startY: e.clientY };
    };

    const onMouseMove = (e: MouseEvent): void => {
      if (!pendingDrag) return;
      if ((e.buttons & 1) === 0) {
        pendingDrag = null;
        return;
      }
      if (!this.isTauriActive()) {
        pendingDrag = null;
        return;
      }
      const dx = e.clientX - pendingDrag.startX;
      const dy = e.clientY - pendingDrag.startY;
      if (dx * dx + dy * dy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
        pendingDrag = null;
        void getCurrentWindow()
          .startDragging()
          .catch(() => {});
      }
    };

    const clearPending = (): void => {
      pendingDrag = null;
    };

    container.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", clearPending);
    window.addEventListener("blur", clearPending);

    return () => {
      container.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", clearPending);
      window.removeEventListener("blur", clearPending);
    };
  }

  public cleanupOnUnload(): void {
    if (
      this.active ||
      this.entering ||
      document.body.classList.contains("mini-player") ||
      document.pictureInPictureElement === this.videoEl
    ) {
      void this.exit();
    }
  }

  private notifyStateChange(): void {
    this.onStateChange?.(this.active, this.corner);
  }

  private async enterTauri(): Promise<void> {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
    }

    const appWindow = getCurrentWindow();
    let unmaximizedForEnter = false;

    try {
      const wasMaximized = await appWindow.isMaximized();
      if (wasMaximized) {
        await appWindow.unmaximize();
        unmaximizedForEnter = true;
      }

      const [innerSize, outerPosition] = await Promise.all([
        appWindow.innerSize(),
        appWindow.outerPosition(),
      ]);
      this.savedGeometry = { innerSize, outerPosition, wasMaximized };

      document.body.classList.add("mini-player");
      this.active = true;
      this.mode = "tauri";

      await appWindow.setMinSize(
        new LogicalSize(MINI_WINDOW_MIN_SIZE.width, MINI_WINDOW_MIN_SIZE.height)
      );
      await appWindow.setDecorations(false);
      await appWindow.setAlwaysOnTop(true);
      await appWindow.setSize(
        new LogicalSize(
          MINI_WINDOW_DEFAULT_SIZE.width,
          MINI_WINDOW_DEFAULT_SIZE.height
        )
      );
      await this.applyCornerSnap(this.corner);
      this.notifyStateChange();
    } catch {
      if (this.savedGeometry || this.active || document.body.classList.contains("mini-player")) {
        await this.exitTauri();
      } else if (unmaximizedForEnter) {
        try {
          await appWindow.maximize();
        } catch {
          // best-effort
        }
      }
    }
  }

  private async exitTauri(): Promise<void> {
    const appWindow = getCurrentWindow();
    const saved = this.savedGeometry;

    try {
      try {
        await appWindow.setAlwaysOnTop(false);
      } catch {
        // best-effort
      }
      try {
        await appWindow.setDecorations(true);
      } catch {
        // best-effort
      }
      try {
        await appWindow.setMinSize(
          new LogicalSize(
            NORMAL_WINDOW_MIN_SIZE.width,
            NORMAL_WINDOW_MIN_SIZE.height
          )
        );
      } catch {
        // best-effort
      }

      if (saved) {
        try {
          await appWindow.setPosition(saved.outerPosition);
        } catch {
          // best-effort
        }
        try {
          await appWindow.setSize(saved.innerSize);
        } catch {
          // best-effort
        }
        if (saved.wasMaximized) {
          try {
            await appWindow.maximize();
          } catch {
            // best-effort
          }
        }
      }
    } finally {
      document.body.classList.remove("mini-player");
      this.active = false;
      this.mode = "none";
      this.savedGeometry = null;
      this.notifyStateChange();
    }
  }

  private async applyCornerSnap(corner: MiniPlayerCorner): Promise<void> {
    const appWindow = getCurrentWindow();
    const monitor = (await currentMonitor()) ?? (await primaryMonitor());
    if (!monitor) return;

    const outerSize = await appWindow.outerSize();
    const workArea = monitor.workArea
      ? {
          x: monitor.workArea.position.x,
          y: monitor.workArea.position.y,
          width: monitor.workArea.size.width,
          height: monitor.workArea.size.height,
        }
      : {
          x: monitor.position.x,
          y: monitor.position.y,
          width: monitor.size.width,
          height: monitor.size.height,
        };

    const pt = computeCornerPosition(
      corner,
      workArea,
      { width: outerSize.width, height: outerSize.height },
      monitor.scaleFactor
    );
    await appWindow.setPosition(new PhysicalPosition(pt.x, pt.y));
  }

  private async enterBrowserPip(): Promise<void> {
    if (!this.isSupported()) return;
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
    }
    try {
      await this.videoEl.requestPictureInPicture();
      this.active = true;
      this.mode = "browser-pip";
      this.notifyStateChange();
    } catch {
      this.active = false;
      this.mode = "none";
      this.notifyStateChange();
    }
  }

  private async exitBrowserPip(): Promise<void> {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      }
    } catch {
      // best-effort
    } finally {
      this.active = false;
      this.mode = "none";
      this.notifyStateChange();
    }
  }
}
