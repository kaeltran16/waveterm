import { describe, expect, it } from "vitest";
import { resolveComposerTarget } from "./composertarget";

describe("resolveComposerTarget", () => {
    it("targets the live worker on a channel with one, when no command is typed", () => {
        const t = resolveComposerTarget({
            composerTarget: "worker-or-jarvis",
            draft: "make it faster",
            workerName: "impl-2",
            runLabel: "run 4c",
        });
        expect(t).toEqual({ audience: "worker", label: "impl-2 · run 4c", needsChannelPicker: false });
    });

    it("switches to Jarvis the moment @ask is typed, even on a channel with a live worker", () => {
        const t = resolveComposerTarget({
            composerTarget: "worker-or-jarvis",
            draft: "@ask why did we drop it",
            workerName: "impl-2",
            runLabel: "run 4c",
        });
        expect(t.audience).toBe("jarvis");
        expect(t.needsChannelPicker).toBe(false);
    });

    it("separates dispatch from consult — Enter on a channel spends money, on a thread it asks", () => {
        const launch = resolveComposerTarget({ composerTarget: "worker-or-jarvis", draft: "add the counter" });
        const consult = resolveComposerTarget({ composerTarget: "worker-or-jarvis", draft: "@ask what changed" });
        expect(launch.label).toBe("Jarvis · dispatch");
        expect(consult.label).toBe("Jarvis · consult");
        expect(launch.label).not.toBe(resolveComposerTarget({ composerTarget: "jarvis-thread", draft: "" }).label);
    });

    it("targets Jarvis on a channel with no live worker", () => {
        const t = resolveComposerTarget({
            composerTarget: "worker-or-jarvis",
            draft: "anything",
            workerName: undefined,
            runLabel: undefined,
        });
        expect(t.audience).toBe("jarvis");
    });

    it("always targets Jarvis on a conversation and never asks for a channel to chat", () => {
        const t = resolveComposerTarget({ composerTarget: "jarvis-thread", draft: "keep going" });
        expect(t).toEqual({ audience: "jarvis", label: "Jarvis · this thread", needsChannelPicker: false });
    });

    it("needs a channel picker for @run on a conversation — there is no channel in scope", () => {
        const t = resolveComposerTarget({ composerTarget: "jarvis-thread", draft: "@run investigate it" });
        expect(t.needsChannelPicker).toBe(true);
    });

    it("needs a channel picker for @quick on a record too", () => {
        const t = resolveComposerTarget({ composerTarget: "jarvis-record", draft: "@quick check the flag" });
        expect(t.needsChannelPicker).toBe(true);
        expect(t.label).toBe("Jarvis · scoped to this record");
    });

    it("does not need a picker for @ask on a record", () => {
        expect(
            resolveComposerTarget({ composerTarget: "jarvis-record", draft: "@ask what changed" }).needsChannelPicker
        ).toBe(false);
    });

    it("treats a bare goal on a record as a question for Jarvis, not a dispatch", () => {
        // parseComposerCommand defaults a bare goal to @run because on a CHANNEL a bare goal starts a run.
        // Off-channel there is no run to start, so only an explicit @run/@quick is a dispatch — otherwise
        // every plain sentence typed at Jarvis would demand a channel before it could be answered.
        expect(
            resolveComposerTarget({ composerTarget: "jarvis-record", draft: "add the counter" }).needsChannelPicker
        ).toBe(false);
    });

    it("needs a picker for an explicit @run on a record", () => {
        expect(
            resolveComposerTarget({ composerTarget: "jarvis-record", draft: "@run add the counter" })
                .needsChannelPicker
        ).toBe(true);
    });
});

describe("briefing composer target", () => {
    it("treats the briefing composer as a plain jarvis ask with no dispatch", () => {
        const t = resolveComposerTarget({ composerTarget: "jarvis-briefing", draft: "@quick fix it" });
        expect(t).toEqual({ audience: "jarvis", label: "All work", needsChannelPicker: false });
    });
});
