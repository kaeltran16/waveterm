import { beforeEach, describe, expect, it, vi } from "vitest";

const openBoardAsk = vi.hoisted(() => vi.fn());
vi.mock("@/app/view/jarvis/openref", () => ({ openBoardAsk: (...a: unknown[]) => openBoardAsk(...a) }));

import { askBoardAction, pickBoardChannel } from "./boardask";

const channel = (oid: string, name: string, projectpath?: string) =>
    ({ oid, otype: "channel", version: 1, name, projectpath, createdts: 0 }) as Channel;

describe("askBoardAction", () => {
    const about: BoardSource = { kind: "run", ref: "r1", title: "run r1" };
    const target = (t: { ok: boolean }) => (t.ok ? { channelId: "ch1", about } : null);
    const action = askBoardAction("run", target);
    const model = {} as any;

    beforeEach(() => openBoardAsk.mockClear());

    it("is the open group's Ask a board about this…, with no input level", () => {
        expect(action.id).toBe("run:ask-board");
        expect(action.label).toBe("Ask a board about this…");
        expect(action.group).toBe("open");
        expect(action.input).toBeUndefined();
    });
    it("applies only when the thing has a target", () => {
        expect(action.applies({ ok: true })).toBe(true);
        expect(action.applies({ ok: false })).toBe(false);
    });
    it("runs by opening the Boards form on the target's project and thing", () => {
        void action.run({ ok: true }, { model });
        expect(openBoardAsk).toHaveBeenCalledWith(model, "ch1", about);
    });
    it("refuses to run with no target", () => {
        expect(() => action.run({ ok: false }, { model })).toThrow(/nothing to ask about/);
        expect(openBoardAsk).not.toHaveBeenCalled();
    });
});

describe("pickBoardChannel", () => {
    const channels = [channel("ch1", "waveterm", "C:\\work\\waveterm"), channel("ch2", "siem", "C:/work/siem")];
    const current = () => channels[1];
    it("takes the channel whose project path matches, whatever the separators", () => {
        expect(pickBoardChannel(channels, current, "C:/work/waveterm/")).toBe("ch1");
    });
    it("falls back to the channel named like the project, then the current project", () => {
        expect(pickBoardChannel(channels, current, "C:/elsewhere", "waveterm")).toBe("ch1");
        expect(pickBoardChannel(channels, current, "C:/elsewhere", "nope")).toBe("ch2");
        expect(pickBoardChannel(channels, current)).toBe("ch2");
    });
    it("has no channel with no match and no current project", () => {
        expect(pickBoardChannel(channels, () => null, "C:/elsewhere")).toBeNull();
        expect(pickBoardChannel(null, () => null)).toBeNull();
    });
});
