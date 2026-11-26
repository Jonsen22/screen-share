import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeCornerPosition,
  getNextCorner,
  MINI_PLAYER_CORNER_LABELS,
  MINI_PLAYER_CORNER_ORDER,
  MINI_WINDOW_DEFAULT_SIZE,
  MINI_WINDOW_MIN_SIZE,
  NORMAL_WINDOW_MIN_SIZE,
} from "../src/mini-player-geometry.ts";

describe("mini-player geometry constants", () => {
  it("exposes expected window size presets and corner order", () => {
    assert.deepEqual(NORMAL_WINDOW_MIN_SIZE, { width: 780, height: 540 });
    assert.deepEqual(MINI_WINDOW_MIN_SIZE, { width: 240, height: 135 });
    assert.deepEqual(MINI_WINDOW_DEFAULT_SIZE, { width: 400, height: 225 });
    assert.deepEqual(MINI_PLAYER_CORNER_ORDER, [
      "bottom-right",
      "bottom-left",
      "top-left",
      "top-right",
    ]);
    for (const corner of MINI_PLAYER_CORNER_ORDER) {
      assert.equal(typeof MINI_PLAYER_CORNER_LABELS[corner], "string");
      assert.ok(MINI_PLAYER_CORNER_LABELS[corner].length > 0);
    }
  });
});

describe("getNextCorner", () => {
  it("cycles through all 4 corners clockwise and wraps back to bottom-right", () => {
    let corner = "bottom-right";
    corner = getNextCorner(corner);
    assert.equal(corner, "bottom-left");
    corner = getNextCorner(corner);
    assert.equal(corner, "top-left");
    corner = getNextCorner(corner);
    assert.equal(corner, "top-right");
    corner = getNextCorner(corner);
    assert.equal(corner, "bottom-right");
  });
});

describe("computeCornerPosition", () => {
  const workArea1080p = { x: 0, y: 0, width: 1920, height: 1040 };

  it("snaps all 4 corners accurately on 1080p workArea at scaleFactor = 1", () => {
    const win = { width: 400, height: 225 };
    assert.deepEqual(
      computeCornerPosition("bottom-right", workArea1080p, win, 1),
      { x: 1504, y: 799 }
    );
    assert.deepEqual(
      computeCornerPosition("bottom-left", workArea1080p, win, 1),
      { x: 16, y: 799 }
    );
    assert.deepEqual(
      computeCornerPosition("top-left", workArea1080p, win, 1),
      { x: 16, y: 16 }
    );
    assert.deepEqual(
      computeCornerPosition("top-right", workArea1080p, win, 1),
      { x: 1504, y: 16 }
    );
  });

  it("scales margin by HiDPI scaleFactor = 1.5", () => {
    const win = { width: 600, height: 338 }; // 400x225 logical at 1.5x
    // margin = Math.round(16 * 1.5) = 24
    assert.deepEqual(
      computeCornerPosition("bottom-right", workArea1080p, win, 1.5),
      { x: 1920 - 600 - 24, y: 1040 - 338 - 24 }
    );
    assert.deepEqual(
      computeCornerPosition("top-left", workArea1080p, win, 1.5),
      { x: 24, y: 24 }
    );
  });

  it("supports negative multi-monitor workArea coordinates", () => {
    const leftMonitor = { x: -1920, y: -100, width: 1920, height: 1040 };
    const win = { width: 400, height: 225 };
    assert.deepEqual(
      computeCornerPosition("top-left", leftMonitor, win, 1),
      { x: -1904, y: -84 }
    );
    assert.deepEqual(
      computeCornerPosition("bottom-right", leftMonitor, win, 1),
      { x: -416, y: 699 }
    );
    assert.deepEqual(
      computeCornerPosition("bottom-left", leftMonitor, win, 1),
      { x: -1904, y: 699 }
    );
    assert.deepEqual(
      computeCornerPosition("top-right", leftMonitor, win, 1),
      { x: -416, y: -84 }
    );
  });

  it("respects custom user-resized mini-player dimensions", () => {
    const customWin = { width: 640, height: 360 };
    assert.deepEqual(
      computeCornerPosition("bottom-right", workArea1080p, customWin, 1),
      { x: 1920 - 640 - 16, y: 1040 - 360 - 16 }
    );
  });

  it("clamps oversized windows within workArea and handles invalid scaleFactor", () => {
    const tinyArea = { x: 100, y: 50, width: 300, height: 200 };
    const oversizedWin = { width: 500, height: 400 };
    assert.deepEqual(
      computeCornerPosition("bottom-right", tinyArea, oversizedWin, 1),
      { x: 100, y: 50 }
    );
    assert.deepEqual(
      computeCornerPosition("top-left", tinyArea, oversizedWin, 1),
      { x: 100, y: 50 }
    );

    const normalWin = { width: 400, height: 225 };
    // scaleFactor <= 0 or NaN falls back to 1 (margin = 16)
    assert.deepEqual(
      computeCornerPosition("top-left", workArea1080p, normalWin, 0),
      { x: 16, y: 16 }
    );
    assert.deepEqual(
      computeCornerPosition("top-left", workArea1080p, normalWin, -2),
      { x: 16, y: 16 }
    );
    assert.deepEqual(
      computeCornerPosition("top-left", workArea1080p, normalWin, Number.NaN),
      { x: 16, y: 16 }
    );
  });
});
