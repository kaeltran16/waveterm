import { describe, expect, it } from "vitest";
import { kindOfKey } from "./index";
import { actionsFor, verbRows, type ThingAction, type ThingKindDef } from "./types";

type T = { id: string; live: boolean };
const cancel: ThingAction<T> = {
    id: "t:cancel",
    label: "Cancel run",
    group: "stop",
    applies: (t) => t.live,
    run: () => {},
};
const open: ThingAction<T> = {
    id: "t:open",
    label: "Open in Jarvis",
    group: "open",
    applies: () => true,
    run: () => {},
};
const def: ThingKindDef<T> = { kind: "run", noun: "Run", actions: [open, cancel], entries: () => [] };
const e = (id: string, live: boolean) => ({ key: `run:${id}`, title: `run ${id}`, thing: { id, live } });

describe("action registry", () => {
    it("splits available by group and lists the rest as not now", () => {
        const l = actionsFor(def.actions, { id: "1", live: false });
        expect(l.available.open).toEqual([open]);
        expect(l.available.stop).toEqual([]);
        expect(l.notNow).toEqual([cancel]);
    });
    it("expands a verb once per thing it applies to", () => {
        const rows = verbRows(def, [e("1", true), e("2", false), e("3", true)]).filter((r) => r.action === cancel);
        expect(rows.map((r) => r.key)).toEqual(["action:t:cancel:run:1", "action:t:cancel:run:3"]);
        expect(rows[0].search).toBe("Cancel run run 1");
    });
    it("kindOfKey resolves by prefix", () => {
        expect(kindOfKey("run:abc")?.noun).toBe("Run");
        expect(kindOfKey("effort:effort:x")?.noun).toBe("Initiative");
        expect(kindOfKey("widen")).toBeUndefined();
    });
});
