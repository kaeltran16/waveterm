import { describe, expect, it } from "vitest";
import { petErrandState } from "./peterrandmodel";

const harnesses: HarnessInfo[] = [
    { runtime: "claude", label: "Claude Code", installed: true, consultcapable: true, runworkercapable: true },
    { runtime: "codex", label: "Codex", installed: true, consultcapable: true, runworkercapable: true },
    { runtime: "opencode", label: "OpenCode", installed: true, consultcapable: true, runworkercapable: true },
];

describe("petErrandState", () => {
    it("blocks without a persisted consult harness", () => {
        expect(
            petErrandState({ channel: true, draft: "ask", busy: false, runtime: "", saving: false, harnesses })
        ).toMatchObject({
            disabled: true,
            reason: "Choose a harness",
        });
    });

    it("allows the selected installed consult harness", () => {
        expect(
            petErrandState({ channel: true, draft: "ask", busy: false, runtime: "opencode", saving: false, harnesses })
        ).toMatchObject({
            disabled: false,
        });
    });

    it("blocks while the preference write is in flight", () => {
        expect(
            petErrandState({ channel: true, draft: "ask", busy: false, runtime: "opencode", saving: true, harnesses })
        ).toMatchObject({ disabled: true, reason: "saving harness preference…" });
    });

    it("blocks a saved-but-uninstalled harness rather than falling to first-installed", () => {
        const notInstalled = harnesses.map((h) => (h.runtime === "opencode" ? { ...h, installed: false } : h));
        expect(
            petErrandState({ channel: true, draft: "ask", busy: false, runtime: "opencode", saving: false, harnesses: notInstalled })
        ).toMatchObject({ disabled: true, reason: "Choose a harness" });
    });

    it("blocks with no channel and on an empty draft", () => {
        expect(
            petErrandState({ channel: false, draft: "ask", busy: false, runtime: "opencode", saving: false, harnesses })
        ).toMatchObject({ disabled: true, reason: "no channel active" });
        expect(
            petErrandState({ channel: true, draft: "  ", busy: false, runtime: "opencode", saving: false, harnesses })
        ).toMatchObject({ disabled: true, reason: "empty draft" });
    });
});
