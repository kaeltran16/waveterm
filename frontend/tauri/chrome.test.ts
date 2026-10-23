import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    setZoom: vi.fn(() => Promise.resolve()),
    setFullscreen: vi.fn(() => Promise.resolve()),
    isFullscreen: vi.fn(() => Promise.resolve(false)),
}));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom: h.setZoom }) }));
vi.mock("@tauri-apps/api/window", () => ({
    getCurrentWindow: () => ({ setFullscreen: h.setFullscreen, isFullscreen: h.isFullscreen }),
}));

// fresh module per test so module-scope state (factor, subscriber lists, ctrl-shift) resets.
let chrome: typeof import("./chrome");
beforeEach(async () => {
    vi.resetModules();
    for (const f of Object.values(h)) f.mockClear();
    chrome = await import("./chrome");
});

describe("zoom controller", () => {
    it("starts at 1 and notifies + sets webview zoom on change", () => {
        const cb = vi.fn();
        chrome.onZoomFactorChange(cb);
        expect(chrome.getZoomFactor()).toBe(1);
        chrome.zoomIn();
        expect(chrome.getZoomFactor()).toBeCloseTo(1.1);
        expect(h.setZoom).toHaveBeenCalledWith(expect.closeTo(1.1));
        expect(cb).toHaveBeenCalledWith(expect.closeTo(1.1));
    });
    it("clamps within [0.5, 3] and resets to 1", () => {
        for (let i = 0; i < 50; i++) chrome.zoomIn();
        expect(chrome.getZoomFactor()).toBeLessThanOrEqual(3);
        for (let i = 0; i < 100; i++) chrome.zoomOut();
        expect(chrome.getZoomFactor()).toBeGreaterThanOrEqual(0.5);
        chrome.zoomReset();
        expect(chrome.getZoomFactor()).toBe(1);
    });
});

describe("fullscreen toggle", () => {
    it("toggles from the current state and notifies", async () => {
        const cb = vi.fn();
        chrome.onFullScreenChange(cb);
        await chrome.toggleFullscreen();
        expect(h.setFullscreen).toHaveBeenCalledWith(true);
        expect(cb).toHaveBeenCalledWith(true);
    });
});

describe("ctrl-shift compute", () => {
    it("emits true on ctrl+shift keydown without meta, false on release", () => {
        const cb = vi.fn();
        chrome.onControlShiftStateUpdate(cb);
        chrome.applyKeyToCtrlShift({ type: "keydown", ctrl: true, shift: true, meta: false });
        expect(cb).toHaveBeenLastCalledWith(true);
        chrome.applyKeyToCtrlShift({ type: "keyup", ctrl: true, shift: false, meta: false });
        expect(cb).toHaveBeenLastCalledWith(false);
    });
    it("does not emit for ctrl or shift alone", () => {
        const cb = vi.fn();
        chrome.onControlShiftStateUpdate(cb);
        chrome.applyKeyToCtrlShift({ type: "keydown", ctrl: true, shift: false, meta: false });
        chrome.applyKeyToCtrlShift({ type: "keydown", ctrl: false, shift: true, meta: false });
        expect(cb).not.toHaveBeenCalled();
    });
    it("ignores a keyup that leaves ctrl and shift both held", () => {
        const cb = vi.fn();
        chrome.onControlShiftStateUpdate(cb);
        chrome.applyKeyToCtrlShift({ type: "keyup", ctrl: true, shift: true, meta: false });
        expect(cb).not.toHaveBeenCalled();
        chrome.applyKeyToCtrlShift({ type: "keydown", ctrl: true, shift: true, meta: false });
        chrome.applyKeyToCtrlShift({ type: "keyup", ctrl: true, shift: true, meta: false });
        expect(cb.mock.calls).toEqual([[true]]);
    });
    it("emits false when a keyup releases ctrl or shift", () => {
        const cb = vi.fn();
        chrome.onControlShiftStateUpdate(cb);
        chrome.applyKeyToCtrlShift({ type: "keydown", ctrl: true, shift: true, meta: false });
        chrome.applyKeyToCtrlShift({ type: "keyup", ctrl: false, shift: true, meta: false });
        expect(cb.mock.calls).toEqual([[true], [false]]);
        chrome.applyKeyToCtrlShift({ type: "keydown", ctrl: true, shift: true, meta: false });
        chrome.applyKeyToCtrlShift({ type: "keyup", ctrl: true, shift: false, meta: false });
        expect(cb.mock.calls).toEqual([[true], [false], [true], [false]]);
    });
    it("does not emit when meta is held, and dedupes repeats", () => {
        const cb = vi.fn();
        chrome.onControlShiftStateUpdate(cb);
        chrome.applyKeyToCtrlShift({ type: "keydown", ctrl: true, shift: true, meta: true });
        chrome.applyKeyToCtrlShift({ type: "keydown", ctrl: true, shift: true, meta: true });
        expect(cb).not.toHaveBeenCalled();
    });
});
