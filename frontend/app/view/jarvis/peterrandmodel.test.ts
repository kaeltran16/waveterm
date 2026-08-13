import { describe, expect, it } from "vitest";
import { petErrandState } from "./peterrandmodel";

const harnesses: HarnessInfo[] = [
    { runtime: "claude", label: "Claude Code", installed: true, consultcapable: true, runworkercapable: true },
    { runtime: "codex", label: "Codex", installed: true, consultcapable: true, runworkercapable: true },
    { runtime: "opencode", label: "OpenCode", installed: true, consultcapable: true, runworkercapable: true },
];

describe("petErrandState", () => {
    it("locks both controls when there is no channel", () => {
        expect(
            petErrandState({
                channel: false,
                draft: "ask",
                busy: false,
                runtime: "opencode",
                saving: false,
                harnesses,
            })
        ).toEqual({
            inputDisabled: true,
            submitDisabled: true,
            reason: "no channel active",
            runtime: "opencode",
        });
    });

    it("locks both controls while a reply is streaming", () => {
        expect(
            petErrandState({
                channel: true,
                draft: "ask",
                busy: true,
                runtime: "opencode",
                saving: false,
                harnesses,
            })
        ).toEqual({
            inputDisabled: true,
            submitDisabled: true,
            reason: "busy",
            runtime: "opencode",
        });
    });

    it("keeps an empty draft editable while blocking only submission", () => {
        expect(
            petErrandState({
                channel: true,
                draft: "  ",
                busy: false,
                runtime: "opencode",
                saving: false,
                harnesses,
            })
        ).toEqual({
            inputDisabled: false,
            submitDisabled: true,
            reason: "empty draft",
            runtime: "opencode",
        });
    });

    it("keeps the draft editable while the harness choice is unresolved", () => {
        expect(
            petErrandState({
                channel: true,
                draft: "ask",
                busy: false,
                runtime: "",
                saving: false,
                harnesses,
            })
        ).toEqual({
            inputDisabled: false,
            submitDisabled: true,
            reason: "Choose a harness",
            runtime: "",
        });

        const notInstalled = harnesses.map((h) => (h.runtime === "opencode" ? { ...h, installed: false } : h));
        expect(
            petErrandState({
                channel: true,
                draft: "ask",
                busy: false,
                runtime: "opencode",
                saving: false,
                harnesses: notInstalled,
            })
        ).toEqual({
            inputDisabled: false,
            submitDisabled: true,
            reason: "Choose a harness",
            runtime: "opencode",
        });
    });

    it("keeps the draft editable while the harness preference is saving", () => {
        expect(
            petErrandState({
                channel: true,
                draft: "ask",
                busy: false,
                runtime: "opencode",
                saving: true,
                harnesses,
            })
        ).toEqual({
            inputDisabled: false,
            submitDisabled: true,
            reason: "saving harness preference…",
            runtime: "opencode",
        });
    });

    it("enables both controls for a non-empty draft and valid harness", () => {
        expect(
            petErrandState({
                channel: true,
                draft: "ask",
                busy: false,
                runtime: "opencode",
                saving: false,
                harnesses,
            })
        ).toEqual({
            inputDisabled: false,
            submitDisabled: false,
            reason: null,
            runtime: "opencode",
        });
    });
});
