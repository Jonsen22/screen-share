export const NORMAL_WINDOW_MIN_SIZE = { width: 780, height: 540 } as const;
export const MINI_WINDOW_MIN_SIZE = { width: 240, height: 135 } as const;
export const MINI_WINDOW_DEFAULT_SIZE = { width: 400, height: 225 } as const;

export const MINI_PLAYER_CORNER_ORDER = [
  "bottom-right",
  "bottom-left",
  "top-left",
  "top-right",
] as const;

export type MiniPlayerCorner = (typeof MINI_PLAYER_CORNER_ORDER)[number];

export const MINI_PLAYER_CORNER_LABELS: Record<MiniPlayerCorner, string> = {
  "bottom-right": "Bottom-Right",
  "bottom-left": "Bottom-Left",
  "top-left": "Top-Left",
  "top-right": "Top-Right",
};

export interface WorkAreaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PixelSize {
  width: number;
  height: number;
}

export interface PixelPoint {
  x: number;
  y: number;
}

export function getNextCorner(current: MiniPlayerCorner): MiniPlayerCorner {
  const idx = MINI_PLAYER_CORNER_ORDER.indexOf(current);
  if (idx === -1) return MINI_PLAYER_CORNER_ORDER[0];
  return MINI_PLAYER_CORNER_ORDER[(idx + 1) % MINI_PLAYER_CORNER_ORDER.length];
}

export function computeCornerPosition(
  corner: MiniPlayerCorner,
  workArea: WorkAreaRect,
  windowSize: PixelSize,
  scaleFactor: number,
  marginLogicalPx = 16
): PixelPoint {
  const safeScale =
    Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  const safeMarginLogical =
    Number.isFinite(marginLogicalPx) && marginLogicalPx > 0
      ? marginLogicalPx
      : 0;
  const margin = Math.round(safeMarginLogical * safeScale);

  const areaX = Number.isFinite(workArea.x) ? workArea.x : 0;
  const areaY = Number.isFinite(workArea.y) ? workArea.y : 0;
  const areaW =
    Number.isFinite(workArea.width) && workArea.width > 0 ? workArea.width : 0;
  const areaH =
    Number.isFinite(workArea.height) && workArea.height > 0
      ? workArea.height
      : 0;

  const winW =
    Number.isFinite(windowSize.width) && windowSize.width > 0
      ? windowSize.width
      : 0;
  const winH =
    Number.isFinite(windowSize.height) && windowSize.height > 0
      ? windowSize.height
      : 0;

  const isLeft = corner === "bottom-left" || corner === "top-left";
  const isTop = corner === "top-left" || corner === "top-right";

  const rawX = isLeft ? areaX + margin : areaX + areaW - winW - margin;
  const rawY = isTop ? areaY + margin : areaY + areaH - winH - margin;

  const minX = areaX;
  const maxX = Math.max(areaX, areaX + areaW - winW);
  const minY = areaY;
  const maxY = Math.max(areaY, areaY + areaH - winH);

  const clampedX = Math.round(Math.min(maxX, Math.max(minX, rawX)));
  const clampedY = Math.round(Math.min(maxY, Math.max(minY, rawY)));

  return {
    x: clampedX === 0 ? 0 : clampedX,
    y: clampedY === 0 ? 0 : clampedY,
  };
}
