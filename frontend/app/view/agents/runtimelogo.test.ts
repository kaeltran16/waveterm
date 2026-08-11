// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { runtimeLogo } from "./runtimelogo";

describe("runtimeLogo", () => {
    it("maps OpenCode to the opencode asset url", () => {
        expect(runtimeLogo("OpenCode")).toContain("opencode");
    });

    it("maps PI to the pi asset", () => {
        // vitest's svgr plugin resolves plain .svg imports to components, not url strings, so the
        // app-side url (".../pi.svg") can't be asserted here; the built app imports the same asset
        // as a url whose basename is "pi.svg". Assert the mapping is present (defined) instead.
        expect(runtimeLogo("PI")).toBeDefined();
    });

    it("returns undefined for unknown runtimes", () => {
        expect(runtimeLogo("unknown")).toBeUndefined();
    });

    it("returns undefined for an undefined runtime (booting/pending agents have none yet)", () => {
        // a just-launched agent's pending row has no `agent` field until the status reporter
        // registers it; the header/detail mark must not throw on that window (regression: the
        // RuntimeMark path crashed the whole app with `undefined.toLowerCase()`)
        expect(runtimeLogo(undefined)).toBeUndefined();
    });
});
