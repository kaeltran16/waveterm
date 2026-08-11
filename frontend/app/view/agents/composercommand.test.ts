// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    LAUNCH_COMMANDS,
    parseComposerCommand,
    resolveComposerDispatch,
    runFooterFor,
    type ResolveComposerDispatchInput,
} from "./composercommand";

const ids = new Set(["claude", "codex", "opencode", "pi", "antigravity"]);

const harnesses: HarnessInfo[] = [
    { runtime: "claude", label: "Claude Code", installed: true, consultcapable: true, runworkercapable: true },
    { runtime: "codex", label: "Codex", installed: true, consultcapable: true, runworkercapable: true },
    { runtime: "opencode", label: "OpenCode", installed: true, consultcapable: true, runworkercapable: true },
    { runtime: "pi", label: "Pi", installed: true, consultcapable: true, runworkercapable: true },
    { runtime: "antigravity", label: "Antigravity", installed: true, consultcapable: true, runworkercapable: true },
];

function dispatchInput(partial: Partial<ResolveComposerDispatchInput>): ResolveComposerDispatchInput {
    return {
        command: { mode: "run", body: "fix" },
        preferredRuntime: "opencode",
        preferenceSaving: false,
        harnesses,
        ...partial,
    };
}

describe("parseComposerCommand", () => {
    it("defaults a bare goal to run", () => {
        expect(parseComposerCommand("fix auth token refresh", ids)).toEqual({ mode: "run", body: "fix auth token refresh" });
    });
    it("parses @quick", () => {
        expect(parseComposerCommand("@quick add a spinner", ids)).toEqual({ mode: "quick", body: "add a spinner" });
    });
    it("parses @run and strips the command", () => {
        expect(parseComposerCommand("@run migrate totals", ids)).toEqual({ mode: "run", body: "migrate totals" });
    });
    it("parses @ask with default runtime", () => {
        expect(parseComposerCommand("@ask where is cart total computed?", ids)).toEqual({
            mode: "ask",
            body: "where is cart total computed?",
        });
    });
    it("parses @ask <runtime> override from the catalog", () => {
        expect(parseComposerCommand("@ask codex inspect", ids)).toEqual({ mode: "ask", runtime: "codex", body: "inspect" });
    });
    it("accepts opencode as an @ask runtime override", () => {
        expect(parseComposerCommand("@ask opencode audit the auth path", ids)).toEqual({
            mode: "ask",
            runtime: "opencode",
            body: "audit the auth path",
        });
    });
    it("accepts pi as an @ask runtime override", () => {
        expect(parseComposerCommand("@ask pi audit the auth path", ids)).toEqual({
            mode: "ask",
            runtime: "pi",
            body: "audit the auth path",
        });
    });
    it("keeps an unknown first token in the body rather than inventing a runtime", () => {
        expect(parseComposerCommand("@ask unknown inspect", ids)).toEqual({ mode: "ask", body: "unknown inspect" });
    });
    it("does not treat a mid-text @ as a command", () => {
        expect(parseComposerCommand("add @mentions to the composer", ids)).toEqual({ mode: "run", body: "add @mentions to the composer" });
    });
    it("trims the goal", () => {
        expect(parseComposerCommand("  @quick   spin  ", ids)).toEqual({ mode: "quick", body: "spin" });
    });
});

describe("resolveComposerDispatch", () => {
    it("blocks a run without a preferred harness and asks to open the picker", () => {
        expect(resolveComposerDispatch(dispatchInput({ command: { mode: "run", body: "fix" }, preferredRuntime: "" }))).toEqual({
            kind: "blocked",
            focusHarness: true,
            reason: "Choose a harness",
        });
    });

    it("blocks a bare ask without a preferred harness", () => {
        expect(
            resolveComposerDispatch(dispatchInput({ command: { mode: "ask", body: "inspect" }, preferredRuntime: "" }))
        ).toEqual({ kind: "blocked", focusHarness: true, reason: "Choose a harness" });
    });

    it("blocks dispatch while the preference write is in flight", () => {
        expect(resolveComposerDispatch(dispatchInput({ preferenceSaving: true }))).toEqual({
            kind: "blocked",
            focusHarness: false,
            reason: "Saving harness preference…",
        });
    });

    it("dispatches a run with the preferred runtime", () => {
        expect(resolveComposerDispatch(dispatchInput({ command: { mode: "run", body: "fix" } }))).toMatchObject({
            kind: "run",
            mode: "run",
            runtime: "opencode",
            body: "fix",
        });
    });

    it("dispatches quick with the preferred runtime", () => {
        expect(resolveComposerDispatch(dispatchInput({ command: { mode: "quick", body: "fast" } }))).toMatchObject({
            kind: "run",
            mode: "quick",
            runtime: "opencode",
        });
    });

    it("treats a bare ask as using the preferred runtime, not a one-off", () => {
        expect(resolveComposerDispatch(dispatchInput({ command: { mode: "ask", body: "inspect" } }))).toMatchObject({
            kind: "ask",
            runtime: "opencode",
            oneOff: false,
        });
    });

    it("treats an explicit @ask override as one-off without consulting the preference", () => {
        expect(
            resolveComposerDispatch(dispatchInput({ command: { mode: "ask", runtime: "codex", body: "inspect" } }))
        ).toMatchObject({ kind: "ask", runtime: "codex", oneOff: true });
    });

    it("blocks an explicit override whose harness is not installed", () => {
        const notInstalled = harnesses.map((h) => (h.runtime === "codex" ? { ...h, installed: false } : h));
        expect(
            resolveComposerDispatch(
                dispatchInput({ harnesses: notInstalled, command: { mode: "ask", runtime: "codex", body: "inspect" } })
            )
        ).toMatchObject({ kind: "blocked", focusHarness: true });
    });
});

describe("runFooterFor", () => {
    it("orchestrator", () => {
        expect(runFooterFor({ playbook: [], defaultmode: "orchestrator" })).toBe("→ adaptive lead · splits the work · set in ⚙");
    });
    it("pipeline with gate", () => {
        expect(runFooterFor({ playbook: [], defaultmode: "pipeline", defaultplangate: true })).toBe("→ pipeline run · stops at a review gate · set in ⚙");
    });
    it("pipeline no gate", () => {
        expect(runFooterFor({ playbook: [], defaultmode: "pipeline", defaultplangate: false })).toBe("→ pipeline run · no gate · set in ⚙");
    });
    it("says the strategy is unresolved rather than asserting a default", () => {
        expect(runFooterFor(undefined)).toBe("→ resolving channel strategy…");
    });
});

describe("LAUNCH_COMMANDS", () => {
    it("has quick/run/ask in order", () => {
        expect(LAUNCH_COMMANDS.map((c) => c.mode)).toEqual(["quick", "run", "ask"]);
        expect(LAUNCH_COMMANDS.map((c) => c.cmd)).toEqual(["@quick", "@run", "@ask"]);
    });
});
