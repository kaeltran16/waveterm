// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { listRows, readModel, revealModel, sendModel, shortId, withCockpitNames } from "./agentscards";
import { parseWshCalls } from "./wshcall";

const lead = {
    tabid: "90d97f06-aaaa-bbbb-cccc-000000000001",
    name: "Lead · SIEM lock investigation",
    projectpath: "C:/p/siem",
    project: "siem-detector",
    runid: "eb4d4b0e-1111-2222-3333-444444444444",
    harness: "claude",
    state: "working",
};
const fable = {
    tabid: "298d47cf-aaaa-bbbb-cccc-000000000002",
    name: "Fable: off-hours rule audit",
    projectpath: "C:/p/siem",
    project: "siem-detector",
    runid: "",
    harness: "claude",
    state: "idle",
};
// shares the 90d97f06 prefix with lead up to 8 chars, so a short prefix is ambiguous
const twin = { ...fable, tabid: "90d97f06-zzzz-bbbb-cccc-000000000003", name: "Twin" };
const roster = [lead, fable];

const call = (command: string) => parseWshCalls(command)[0];

describe("shortId", () => {
    it("cuts an id to the length wsh prints", () => {
        expect(shortId(lead.tabid)).toBe("90d97f06");
        expect(shortId("abc")).toBe("abc");
    });
});

describe("withCockpitNames", () => {
    // several agents in one project share the tab name "waveterm"
    const a = { ...lead, name: "waveterm", title: "Measure agent edits" };
    const b = { ...fable, name: "waveterm", title: "Fix the diff rail" };
    const c = { ...fable, tabid: "c3", name: "waveterm", title: "" };

    it("takes the cockpit's name, else the session title, else the tab name", () => {
        const named = withCockpitNames([a, b, c], [{ id: a.tabid, name: "auth agent" }]);
        expect(named?.map((x) => x.name)).toEqual(["auth agent", "Fix the diff rail", "waveterm"]);
    });

    it("leaves a missing roster missing", () => {
        expect(withCockpitNames(undefined, [])).toBeUndefined();
    });
});

describe("listRows", () => {
    it("puts the run, else the project, else the state in the about column", () => {
        const rows = listRows([lead, fable, { ...fable, tabid: "x1", project: "", state: "asking" }]);
        expect(rows.map((r) => r.about)).toEqual([`run ${shortId(lead.runid)}`, "siem-detector", "asking"]);
        expect(rows.map((r) => r.id)).toEqual(["90d97f06", "298d47cf", "x1"]);
    });

    it("keeps the roster order and falls an unknown state back to idle", () => {
        const rows = listRows([{ ...lead, state: "weird" }, fable]);
        expect(rows.map((r) => r.name)).toEqual([lead.name, fable.name]);
        expect(rows[0].state).toBe("idle");
    });

    it("is empty for no agents", () => {
        expect(listRows([])).toEqual([]);
    });
});

describe("sendModel", () => {
    it("names the target from the roster and carries the sent text", () => {
        const m = sendModel(call(`wsh agents send ${lead.tabid} "new finding"`), roster);
        expect(m).toMatchObject({ name: lead.name, tabid: lead.tabid, text: "new finding" });
    });

    it("resolves a unique prefix and ignores a boolean flag before the tab", () => {
        const m = sendModel(call(`wsh agents send --wait 298d "hi"`), roster);
        expect(m).toMatchObject({ name: fable.name, tabid: fable.tabid, text: "hi" });
    });

    it("falls back to the short id when the roster does not know the tab", () => {
        const m = sendModel(call(`wsh agents send ${lead.tabid} "hi"`), undefined);
        expect(m.name).toBe("90d97f06");
        expect(m.tabid).toBeUndefined();
        const gone = sendModel(call(`wsh agents send ffff1111 "hi"`), roster);
        expect(gone).toMatchObject({ name: "ffff1111", text: "hi" });
        expect(gone.tabid).toBeUndefined();
    });

    it("does not guess between two tabs a prefix matches", () => {
        const m = sendModel(call(`wsh agents send 90d97f06 "hi"`), [lead, twin]);
        expect(m.name).toBe("90d97f06");
        expect(m.tabid).toBeUndefined();
    });

    it("names the file when the text came from --file", () => {
        const m = sendModel(call(`wsh agents send 298d --file notes/brief.md`), roster);
        expect(m.text).toBeUndefined();
        expect(m.file).toBe("notes/brief.md");
    });

    it("reads midturn from the call's --json output only", () => {
        const out = JSON.stringify({ tabid: lead.tabid, sentts: 1, midturn: true });
        const json = `wsh agents send --json ${lead.tabid} "hi"`;
        expect(sendModel(call(json), roster, { command: json, output: out, exit: 0 }).midTurn).toBe(true);
        const plain = `wsh agents send ${lead.tabid} "hi"`;
        expect(sendModel(call(plain), roster, { command: plain, output: out, exit: 0 }).midTurn).toBeUndefined();
    });
});

describe("readModel", () => {
    it("takes the answer and the full tab id from --json output", () => {
        const cmd = `wsh agents read --json 298d`;
        const out = JSON.stringify({ tabid: fable.tabid, state: "idle", answer: "UTC or local?", answerts: 5 });
        const m = readModel(call(cmd), roster, { command: cmd, output: out, exit: 0 });
        expect(m).toMatchObject({ name: fable.name, tabid: fable.tabid, answer: "UTC or local?" });
    });

    it("takes the output body when the call printed the answer", () => {
        const cmd = `wsh agents read ${fable.tabid}`;
        const m = readModel(call(cmd), roster, { command: cmd, output: "the answer\nline two\n", exit: 0 });
        expect(m).toMatchObject({ name: fable.name, tabid: fable.tabid, answer: "the answer\nline two" });
    });

    it("has an empty answer and no link for an unknown tab without output", () => {
        const m = readModel(call(`wsh agents read zzzz0000`), roster);
        expect(m).toMatchObject({ name: "zzzz0000", answer: "" });
        expect(m.tabid).toBeUndefined();
    });
});

describe("revealModel", () => {
    it("says Showed for an agent address and names it from the roster", () => {
        const m = revealModel(`agent:${fable.tabid}`, roster);
        expect(m).toEqual({ kind: "show", label: fable.name, mono: false });
        expect(revealModel(`tab:${lead.tabid}`, roster)).toMatchObject({ kind: "show", label: lead.name });
    });

    it("shows the id of an agent the roster lacks", () => {
        expect(revealModel("agent:ffff1111-x", roster)).toEqual({ kind: "show", label: "ffff1111", mono: true });
    });

    it("says Showed with the address for another Arc object", () => {
        expect(revealModel("run:eb4d4b0e", roster)).toEqual({ kind: "show", label: "run:eb4d4b0e", mono: true });
        expect(revealModel("surface:diff", roster).kind).toBe("show");
    });

    it("says Opened with the path for a file, a Windows drive path included", () => {
        expect(revealModel("scratch/prod-inv/prod_inv.sh", roster)).toEqual({
            kind: "open",
            label: "scratch/prod-inv/prod_inv.sh",
            mono: true,
        });
        expect(revealModel("C:/work/a.go", roster).kind).toBe("open");
    });
});
