import { describe, expect, it } from "vitest";
import { MODEL_ALIASES, modelCommand, permissionModeKeys, permissionModeLabel } from "./headercontrolsmodel";

const SHIFT_TAB = "\x1b[Z";

describe("permissionModeKeys", () => {
    it("types one shift+tab per step around the default -> acceptEdits -> plan cycle", () => {
        expect(permissionModeKeys("default", "plan")).toEqual([SHIFT_TAB, SHIFT_TAB]);
        expect(permissionModeKeys("plan", "default")).toEqual([SHIFT_TAB]);
        expect(permissionModeKeys("default", "acceptEdits")).toEqual([SHIFT_TAB]);
        expect(permissionModeKeys("acceptEdits", "default")).toEqual([SHIFT_TAB, SHIFT_TAB]);
    });
    it("types nothing when already there", () => {
        expect(permissionModeKeys("plan", "plan")).toEqual([]);
    });
    it("is null when either mode is outside the cycle", () => {
        expect(permissionModeKeys("bypassPermissions", "default")).toBeNull();
        expect(permissionModeKeys("default", "bypassPermissions")).toBeNull();
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
