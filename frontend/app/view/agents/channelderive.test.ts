// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentVM } from "./agentsviewmodel";
import { avatarColor, channelHasAsk } from "./channelderive";

describe("avatarColor", () => {
    it("is deterministic for the same name", () => {
        expect(avatarColor("codex")).toBe(avatarColor("codex"));
    });

    it("pins 'you' to the accent token, case-insensitively", () => {
        expect(avatarColor("you")).toBe("var(--color-accent)");
        expect(avatarColor("YOU")).toBe("var(--color-accent)");
    });

    it("returns a palette token for other names", () => {
        const palette = new Set([
            "var(--color-avatar-1)",
            "var(--color-avatar-2)",
            "var(--color-avatar-3)",
            "var(--color-avatar-4)",
            "var(--color-avatar-5)",
            "var(--color-avatar-6)",
        ]);
        expect(palette.has(avatarColor("claude"))).toBe(true);
        expect(palette.has(avatarColor("antigravity"))).toBe(true);
    });
});

const agent = (id: string, state: AgentVM["state"]): AgentVM =>
    ({ id, name: id, task: "", state }) as AgentVM;

const chan = (messages: unknown[]): Channel => ({ messages } as unknown as Channel);

describe("channelHasAsk", () => {
    it("is true when a dispatched worker is asking", () => {
        const ch = chan([{ kind: "dispatch", reforef: "tab:a1" }]);
        expect(channelHasAsk(ch, [agent("a1", "asking")])).toBe(true);
    });

    it("is false when the dispatched worker is only working", () => {
        const ch = chan([{ kind: "dispatch", reforef: "tab:a1" }]);
        expect(channelHasAsk(ch, [agent("a1", "working")])).toBe(false);
    });

    it("is false when no dispatch/directive references an asking agent", () => {
        const ch = chan([{ kind: "human", reforef: "" }]);
        expect(channelHasAsk(ch, [agent("a1", "asking")])).toBe(false);
    });

    it("is true via a directive (steer) reference too", () => {
        const ch = chan([{ kind: "directive", reforef: "tab:a2" }]);
        expect(channelHasAsk(ch, [agent("a2", "asking")])).toBe(true);
    });

    it("is false for a channel with no messages", () => {
        expect(channelHasAsk(chan([]), [agent("a1", "asking")])).toBe(false);
    });
});
