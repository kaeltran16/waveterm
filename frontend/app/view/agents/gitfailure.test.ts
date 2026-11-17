// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { failureHeadline } from "./gitfailure";

describe("failureHeadline", () => {
    it("skips a leading warning to reach git's fatal line", () => {
        expect(
            failureHeadline("warning: in the working copy of 'a', LF will be replaced by CRLF\nfatal: cannot hash a")
        ).toBe("fatal: cannot hash a");
    });

    it("takes the first fatal or error line", () => {
        expect(failureHeadline("error: x\nfatal: y")).toBe("error: x");
    });

    it("falls back to the first line that is not a warning or hint", () => {
        expect(failureHeadline("warning: w\nplain")).toBe("plain");
        expect(failureHeadline("hint: h\nwarning: w\nplain")).toBe("plain");
    });

    it("shows a warning-only stderr rather than nothing", () => {
        expect(failureHeadline("warning: only")).toBe("warning: only");
    });

    // a push prints its per-ref status ahead of the error line; the rejected ref is the reason
    it("takes a push's rejected ref line over its error line", () => {
        const stderr = [
            "To /tmp/origin.git",
            " ! [rejected]        main -> main (fetch first)",
            "error: failed to push some refs to '/tmp/origin.git'",
            "hint: Updates were rejected because the remote contains work that you do not",
        ].join("\n");
        expect(failureHeadline(stderr)).toBe("! [rejected]        main -> main (fetch first)");
    });

    it("is empty for empty stderr", () => {
        expect(failureHeadline("")).toBe("");
    });

    it("ignores CRLF line endings and blank lines", () => {
        expect(failureHeadline("\r\nwarning: w\r\nfatal: f\r\n")).toBe("fatal: f");
    });
});
