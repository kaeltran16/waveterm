import { describe, expect, it } from "vitest";
import {
    MODEL_ALIASES,
    modelCommand,
    permissionCycle,
    permissionModeKeys,
    permissionModeLabel,
    shownPermissionMode,
} from "./headercontrolsmodel";

const SHIFT_TAB = "\x1b[Z";

describe("permissionCycle", () => {
    it("is default -> acceptEdits -> plan until any session reports auto", () => {
        expect(permissionCycle(new Set(["default", "plan"]), false)).toEqual(["default", "acceptEdits", "plan"]);
    });
    it("walks auto after plan once the session has reported it", () => {
        expect(permissionCycle(new Set(["auto"]), false)).toEqual(["default", "acceptEdits", "plan", "auto"]);
    });
    it("walks auto in a session that has not reported it once another session has", () => {
        expect(permissionCycle(new Set(["default"]), true)).toEqual(["default", "acceptEdits", "plan", "auto"]);
    });
});

describe("permissionModeKeys", () => {
    const three = permissionCycle(new Set(), false);
    const four = permissionCycle(new Set(["auto"]), false);

    it("types one shift+tab per step around the default -> acceptEdits -> plan cycle", () => {
        expect(permissionModeKeys(three, "default", "plan")).toEqual([SHIFT_TAB, SHIFT_TAB]);
        expect(permissionModeKeys(three, "plan", "default")).toEqual([SHIFT_TAB]);
        expect(permissionModeKeys(three, "default", "acceptEdits")).toEqual([SHIFT_TAB]);
        expect(permissionModeKeys(three, "acceptEdits", "default")).toEqual([SHIFT_TAB, SHIFT_TAB]);
    });
    it("steps through auto when it is in the cycle", () => {
        expect(permissionModeKeys(four, "plan", "default")).toEqual([SHIFT_TAB, SHIFT_TAB]);
        expect(permissionModeKeys(four, "auto", "default")).toEqual([SHIFT_TAB]);
        expect(permissionModeKeys(four, "default", "auto")).toEqual([SHIFT_TAB, SHIFT_TAB, SHIFT_TAB]);
    });
    it("types nothing when already there", () => {
        expect(permissionModeKeys(three, "plan", "plan")).toEqual([]);
    });
    it("is null when either mode is outside the cycle", () => {
        expect(permissionModeKeys(three, "bypassPermissions", "default")).toBeNull();
        expect(permissionModeKeys(three, "default", "bypassPermissions")).toBeNull();
        expect(permissionModeKeys(three, "auto", "default")).toBeNull();
    });
});

describe("shownPermissionMode", () => {
    it("shows the typed mode until a newer hook reports the real one", () => {
        expect(shownPermissionMode({ mode: "plan", hookTs: 5 }, 5, "default")).toBe("plan");
        expect(shownPermissionMode({ mode: "plan", hookTs: 5 }, 6, "acceptEdits")).toBe("acceptEdits");
    });
    it("shows the reported mode with nothing typed", () => {
        expect(shownPermissionMode(null, 5, "default")).toBe("default");
    });
});

describe("permissionModeLabel", () => {
    it("names the cycle's modes and passes an unknown one through", () => {
        expect(permissionModeLabel("default")).toBe("default permissions");
        expect(permissionModeLabel("acceptEdits")).toBe("accept edits");
        expect(permissionModeLabel("plan")).toBe("plan mode");
        expect(permissionModeLabel("bypassPermissions")).toBe("bypassPermissions");
    });
    it("is empty when no mode is known", () => {
        expect(permissionModeLabel(undefined)).toBe("");
    });
});

describe("modelCommand", () => {
    it("is the /model command for an alias", () => {
        expect(modelCommand("opus")).toBe("/model opus");
        expect(MODEL_ALIASES).toEqual(["default", "opus", "sonnet", "haiku"]);
    });
});
