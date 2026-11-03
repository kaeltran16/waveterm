import { describe, expect, it } from "vitest";
import {
    chatItems,
    chatTab,
    composerFor,
    endedText,
    headerStateLabel,
    permissionCard,
    rowStateLabel,
    splitReply,
} from "./static/chatmodel.js";

const MIN = 60 * 1000;
const NOW = 1_800_000_000_000;
const agent = (state, over = {}) => ({
    tab: "tab-1",
    name: "phone-chat",
    project: "waveterm",
    runtime: "claude",
    state,
    since: NOW - 4 * MIN,
    line: "Wants to run: ssh deploy@siem-236",
    ...over,
});
const editDetail = {
    kind: "edit",
    files: [
        { path: "a.go", badge: "M", adds: 12, dels: 2, lines: [] },
        { path: "b.go", badge: "A", adds: 6, dels: 0, lines: [] },
    ],
};

describe("splitReply", () => {
    it("keeps plain text whole, line breaks included", () => {
        expect(splitReply("one\ntwo\n\nthree")).toEqual([{ kind: "text", text: "one\ntwo\n\nthree" }]);
    });

    it("splits a fenced block with its language", () => {
        expect(splitReply("Run this:\n```bash\ngo test ./pkg/x\n```\nThen commit.")).toEqual([
            { kind: "text", text: "Run this:" },
            { kind: "code", lang: "bash", text: "go test ./pkg/x" },
            { kind: "text", text: "Then commit." },
        ]);
    });

    it("splits two fences, one without a language", () => {
        expect(splitReply("```go\na := 1\nb := 2\n```\nand\n```\nplain\n```")).toEqual([
            { kind: "code", lang: "go", text: "a := 1\nb := 2" },
            { kind: "text", text: "and" },
            { kind: "code", lang: "", text: "plain" },
        ]);
    });

    it("runs an unclosed fence to the end as code", () => {
        expect(splitReply("Start:\n```js\nconst a = 1;\nconst b = 2;")).toEqual([
            { kind: "text", text: "Start:" },
            { kind: "code", lang: "js", text: "const a = 1;\nconst b = 2;" },
        ]);
    });

    it("gives markup back as the exact text it was", () => {
        const reply = "<img src=x onerror=alert(1)>";
        expect(splitReply(reply)).toEqual([{ kind: "text", text: reply }]);
    });

    it("gives nothing for an empty reply", () => {
        expect(splitReply("")).toEqual([]);
        expect(splitReply(undefined)).toEqual([]);
    });
});

describe("chatItems", () => {
    it("draws users, replies and actions, and leaves out other entries", () => {
        const items = chatItems([
            { kind: "user", text: "add a heartbeat" },
            { kind: "action", verb: "read", target: "handler.go", summary: "193 lines" },
            { kind: "action", verb: "ran", target: "go test ./pkg/remotemode", outcome: "ok", summary: "31 passing" },
            { kind: "action", verb: "ran", target: "go vet", outcome: "fail" },
            { kind: "compaction" },
            { kind: "message", text: "Done." },
        ]);
        expect(items).toEqual([
            { kind: "user", text: "add a heartbeat" },
            { kind: "action", mark: "pending", verb: "Read", target: "handler.go", summary: "193 lines" },
            { kind: "action", mark: "ok", verb: "Ran", target: "go test ./pkg/remotemode", summary: "31 passing" },
            { kind: "action", mark: "fail", verb: "Ran", target: "go vet", summary: "" },
            { kind: "reply", parts: [{ kind: "text", text: "Done." }] },
        ]);
    });

    it("carries an edit's adds and dels from its detail", () => {
        const [item] = chatItems([{ kind: "action", verb: "edited", target: "handler.go", detail: editDetail }]);
        expect(item).toMatchObject({ kind: "action", verb: "Edited", target: "handler.go", adds: 18, dels: 2 });
    });

    it("marks an action with no outcome pending", () => {
        const [item] = chatItems([{ kind: "action", verb: "ran", target: "ssh deploy@siem-236" }]);
        expect(item.mark).toBe("pending");
    });

    it("gives a duration as the summary when there is no other", () => {
        const [item] = chatItems([
            { kind: "action", verb: "ran", target: "docker build", outcome: "ok", durationMs: 130_000 },
        ]);
        expect(item.summary).toBe("2m 10s");
    });
});

describe("permissionCard", () => {
    it("shows the whole pending Bash command", () => {
        const cmd = "ssh deploy@siem-236 'sudo systemctl restart ingest && journalctl -u ingest -n 50 --no-pager'";
        const entries = [
            { kind: "action", verb: "ran", target: "docker push", outcome: "ok" },
            { kind: "message", text: "Restarting next." },
            { kind: "action", verb: "ran", target: cmd },
        ];
        expect(permissionCard(entries, agent("permission"))).toEqual({
            tool: "Bash",
            ask: "Wants to run a command",
            target: cmd,
        });
    });

    it("shows a pending edit", () => {
        const entries = [{ kind: "action", verb: "edited", target: "handler.go" }];
        expect(permissionCard(entries, agent("permission"))).toEqual({
            tool: "Edit",
            ask: "Wants to edit a file",
            target: "handler.go",
        });
    });

    it("names another tool by its verb", () => {
        const entries = [{ kind: "action", verb: "webfetch", target: "https://example.test" }];
        expect(permissionCard(entries, agent("permission"))).toEqual({
            tool: "webfetch",
            ask: "Wants to use a tool",
            target: "https://example.test",
        });
    });

    it("falls back to the row's line when no action is pending", () => {
        const entries = [{ kind: "action", verb: "ran", target: "docker push", outcome: "ok" }];
        expect(permissionCard(entries, agent("permission"))).toEqual({
            tool: "",
            ask: "Wants your approval",
            target: "Wants to run: ssh deploy@siem-236",
        });
        expect(permissionCard([], agent("permission")).ask).toBe("Wants your approval");
    });
});

describe("composerFor", () => {
    it("messages an idle agent", () => {
        expect(composerFor(agent("idle"))).toEqual({
            label: "Message phone-chat",
            placeholder: "Message phone-chat",
            disabled: false,
            stop: false,
            permission: false,
        });
    });

    it("adds to a working agent's turn, with Stop", () => {
        expect(composerFor(agent("working"))).toEqual({
            label: "Add to this turn",
            placeholder: "Add to this turn",
            disabled: false,
            stop: true,
            permission: false,
        });
    });

    it("denies with a reason during a permission wait", () => {
        expect(composerFor(agent("permission"))).toEqual({
            label: "Deny and tell phone-chat why",
            placeholder: "Deny and say what to do instead",
            disabled: false,
            stop: false,
            permission: true,
        });
    });

    it("sends needs input to the desk with the box disabled", () => {
        expect(composerFor(agent("input"))).toEqual({
            label: "Message phone-chat",
            placeholder: "Message phone-chat",
            disabled: true,
            note: "Needs input · answer it at the desk",
            stop: false,
            permission: false,
        });
    });

    it("sends a question to the Questions list with the box disabled", () => {
        expect(composerFor(agent("asking"))).toEqual({
            label: "Message phone-chat",
            placeholder: "Message phone-chat",
            disabled: true,
            note: "Asking you · answer it under Questions",
            stop: false,
            permission: false,
        });
    });
});

describe("state labels", () => {
    const cases = [
        ["working", NOW - 1 * MIN, "working 1m", "working 1m"],
        ["idle", NOW - 6 * MIN, "idle 6m", "idle · replied 6m ago"],
        ["permission", NOW - 4 * MIN, "needs approval", "needs approval · 4m"],
        ["input", NOW - 4 * MIN, "needs input", "needs input · 4m"],
        ["asking", NOW - 3 * MIN, "asking you", "asking you · 3m"],
    ];
    it.each(cases)("labels %s", (state, since, row, header) => {
        expect(rowStateLabel(agent(state, { since }), NOW)).toBe(row);
        expect(headerStateLabel(agent(state, { since }), NOW)).toBe(header);
    });

    it("leaves the age out when since is unknown", () => {
        expect(rowStateLabel(agent("working", { since: 0 }), NOW)).toBe("working");
        expect(headerStateLabel(agent("idle", { since: 0 }), NOW)).toBe("idle");
    });
});

describe("endedText", () => {
    it("says why the agent is back at the desk", () => {
        expect(endedText("phone-chat", "taken")).toBe(
            "phone-chat was taken back, here or at the desk, so it no longer takes messages from the phone. Hand it over again from the Agent surface."
        );
        expect(endedText("phone-chat", "exited")).toBe("phone-chat exited, so it is off the phone.");
    });

    it("reads an unknown reason as taken", () => {
        expect(endedText("x", "off")).toBe(endedText("x", "taken"));
    });
});

describe("chatTab", () => {
    it("reads the tab from an agent hash", () => {
        expect(chatTab("#agent/tab-1")).toBe("tab-1");
        expect(chatTab("#agent/a%2Fb")).toBe("a/b");
    });

    it("is null for anything else", () => {
        expect(chatTab("")).toBeNull();
        expect(chatTab("#agent/")).toBeNull();
        expect(chatTab("#other/tab-1")).toBeNull();
    });
});
