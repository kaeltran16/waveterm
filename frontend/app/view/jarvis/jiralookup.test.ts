// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { fromLookupError, lookupLine, shouldLookUp, type LookupState } from "./jiralookup";

describe("shouldLookUp", () => {
    it("gives the normalized key when the field changed to a key-shaped value", () => {
        expect(shouldLookUp("", " pay-318 ")).toBe("PAY-318");
    });

    it("is null for the key it already looked up, however it is typed", () => {
        expect(shouldLookUp("PAY-318", "PAY-318")).toBeNull();
        expect(shouldLookUp("PAY-318", " pay-318 ")).toBeNull();
    });

    it("is null for text that is not key-shaped", () => {
        expect(shouldLookUp("", "pay")).toBeNull();
        expect(shouldLookUp("", "")).toBeNull();
        expect(shouldLookUp("PAY-318", "PAY-")).toBeNull();
    });

    it("looks up a different key", () => {
        expect(shouldLookUp("PAY-318", "PAY-381")).toBe("PAY-381");
    });
});

describe("lookupLine", () => {
    it("draws nothing when idle", () => {
        expect(lookupLine({ kind: "idle" })).toBeNull();
    });

    it("says what it is looking up", () => {
        expect(lookupLine({ kind: "looking", key: "PAY-318" })).toEqual({
            text: "Looking up PAY-318 in Jira…",
            tone: "muted",
            fieldError: false,
            connect: false,
        });
    });

    it("draws nothing for a found ticket, whose own row shows it", () => {
        const found: LookupState = { kind: "found", key: "PAY-318", summary: "s", type: "Story", status: "To Do" };
        expect(lookupLine(found)).toBeNull();
    });

    it("marks the field when Jira has no such ticket", () => {
        expect(lookupLine({ kind: "notfound", key: "PAY-381" })).toEqual({
            text: "Jira has no PAY-381, or your account can't see it. Saving keeps it as text.",
            tone: "error",
            fieldError: true,
            connect: false,
        });
    });

    it("offers Connect Jira when Jira is not set up", () => {
        expect(lookupLine({ kind: "off" })).toEqual({
            text: "Saved as text; Arc can't check it until Jira is connected.",
            tone: "faint",
            fieldError: false,
            connect: true,
        });
    });

    it("shows another failure as Jira or the network said it", () => {
        expect(lookupLine({ kind: "error", message: "Jira answered 401: expired" })).toEqual({
            text: "Jira answered 401: expired",
            tone: "error",
            fieldError: false,
            connect: false,
        });
    });
});

describe("fromLookupError", () => {
    it("maps a 404 to not found", () => {
        const err = new Error("EC-JIRA-HTTP 404: Issue does not exist or you do not have permission to see it.");
        expect(fromLookupError("PAY-381", err)).toEqual({ kind: "notfound", key: "PAY-381" });
    });

    it("maps a Jira that is not set up to off", () => {
        const err = new Error("EC-JIRA-NOTCONFIGURED: Jira isn't set up: add your site in Settings > Jira.");
        expect(fromLookupError("PAY-318", err)).toEqual({ kind: "off" });
    });

    it("keeps Jira's status and message for any other refusal", () => {
        const err = new Error("EC-JIRA-HTTP 401: Client must be authenticated to access this resource.");
        expect(fromLookupError("PAY-318", err)).toEqual({
            kind: "error",
            message: "Jira answered 401: Client must be authenticated to access this resource.",
        });
    });

    it("keeps the cause when Jira is unreachable", () => {
        const err = new Error("EC-JIRA-UNREACHABLE: dial tcp: no such host");
        expect(fromLookupError("PAY-318", err)).toEqual({ kind: "error", message: "dial tcp: no such host" });
    });
});
