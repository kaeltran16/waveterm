import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    LONG_TOKEN,
    SETUP_SCENARIO_NAMES,
    arrangeSetupFixture,
    assertSetupFixtureInstalled,
    callSummary,
    controlSetupFixture,
    createFixtureRuntime,
    createSetupFixture,
    installSetupFixture,
    readSetupFixture,
    restoreSetupFixture,
    teardownSetupFixture,
} from "./setup-fixtures.mjs";

const roots = [];
function tempRoot() {
    const r = mkdtempSync(join(tmpdir(), "setup-fixtures-test-"));
    roots.push(r);
    return r;
}
afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

// a fake dev app: scripts the helpers send are evaluated against fake window/performance/RpcApi, with
// the dynamic import swapped for the fake module. No browser, no real config.
function fakePage({ prevMock = null, failOn = {} } = {}) {
    const realCalls = [];
    const api = {
        mockClient: prevMock,
        setMockRpcClient(c) {
            if (failOn.restore && c === prevMock) throw new Error("restore refused");
            this.mockClient = c;
        },
        call(client, command, data) {
            return this.mockClient ? this.mockClient.mockWshRpcCall(client, command, data) : client.wshRpcCall(command, data);
        },
        AgentSyncStatusCommand(client) {
            return failOn.probe ? Promise.resolve(null) : this.call(client, "agentsyncstatus", null);
        },
    };
    const win = {
        TabRpcClient: {
            wshRpcCall(command) {
                realCalls.push(command);
                return Promise.resolve({ real: true, command });
            },
            wshRpcStream() {
                throw new Error("unexpected stream");
            },
        },
    };
    const resources = [{ name: "http://localhost:5174/@fs/repo/frontend/app/store/wshclientapi.ts?t=1" }];
    const perf = { getEntriesByType: () => resources };
    const h = {
        scripts: [],
        async ev(expr) {
            h.scripts.push(expr);
            if (failOn.ev?.test(expr)) throw new Error("transport dropped");
            const fn = new Function("window", "performance", "__imp", `return ${expr.replace(/\bimport\(/g, "__imp(")}`);
            return fn(win, perf, async () => ({ RpcApi: api }));
        },
    };
    return { h, api, win, realCalls, resources };
}

const AGENTSYNC = [
    ["agentsyncstatus", null],
    ["agentsyncsteeringread", null],
    ["agentsyncskills", null],
    ["agentsyncsteeringwrite", { content: "x", basemtime: 1000 }],
    ["agentsyncapply", {}],
    ["agentsyncadopt", { apply: false }],
];

describe("setup fixture safety", () => {
    it("pins the scenario names", () => {
        expect(SETUP_SCENARIO_NAMES).toEqual(["setup-instructions", "setup-skills", "setup-import", "setup-narrow"]);
    });

    it("intercepts every agentsync command and never delegates one", async () => {
        const root = tempRoot();
        const { h, api, realCalls } = fakePage();
        await installSetupFixture(h, createSetupFixture("setup-skills", root));
        for (const [command, data] of AGENTSYNC) {
            await expect(api.call(null, command, data)).resolves.toBeDefined();
        }
        await expect(api.call(null, "agentsyncnew", {})).rejects.toThrow(/unhandled agentsync command/);
        expect(() => api.mockClient.mockWshRpcStream(null, "agentsyncstream", {})).toThrow(/not simulated/);
        expect(realCalls).toEqual([]);
        const snap = await readSetupFixture(h);
        expect(callSummary(snap).unhandled).toBe(1);
    });

    it("routes unrelated commands through the original client, or the prior mock when there is one", async () => {
        const root = tempRoot();
        const plain = fakePage();
        await installSetupFixture(plain.h, createSetupFixture("setup-skills", root));
        await expect(plain.api.call(plain.win.TabRpcClient, "getmeta", {})).resolves.toEqual({ real: true, command: "getmeta" });
        expect(plain.realCalls).toEqual(["getmeta"]);

        const seen = [];
        const prev = {
            mockWshRpcCall: async (_c, command) => {
                seen.push(command);
                return "prior";
            },
        };
        const mocked = fakePage({ prevMock: prev });
        await installSetupFixture(mocked.h, createSetupFixture("setup-skills", tempRoot()));
        await expect(mocked.api.call(null, "getmeta", {})).resolves.toBe("prior");
        expect(seen).toEqual(["getmeta"]);
        expect(mocked.realCalls).toEqual([]);
    });

    it("blocks everything when the module URL cannot be found", async () => {
        const root = tempRoot();
        const { h, resources } = fakePage();
        resources.length = 0;
        await expect(installSetupFixture(h, createSetupFixture("setup-skills", root))).rejects.toThrow(/wshclientapi/);
        expect(existsSync(join(root, "setup-fixture-setup-skills"))).toBe(false);
    });

    it("rolls back when the transport fails before the mock is replaced", async () => {
        const root = tempRoot();
        const prev = { mockWshRpcCall: async () => "prior" };
        const { h, api } = fakePage({ prevMock: prev, failOn: { ev: /const mod = await import/ } });
        await expect(installSetupFixture(h, createSetupFixture("setup-skills", root))).rejects.toThrow(/transport dropped/);
        expect(api.mockClient).toBe(prev);
        expect(existsSync(join(root, "setup-fixture-setup-skills"))).toBe(false);
    });

    it("rolls back when the probe fails after the mock is replaced", async () => {
        const root = tempRoot();
        const prev = { mockWshRpcCall: async () => "prior" };
        const { h, api, win } = fakePage({ prevMock: prev, failOn: { probe: true } });
        await expect(installSetupFixture(h, createSetupFixture("setup-skills", root))).rejects.toThrow(/probe failed/);
        expect(api.mockClient).toBe(prev);
        expect("__arcSetupFixture" in win).toBe(false);
        expect(existsSync(join(root, "setup-fixture-setup-skills"))).toBe(false);
    });

    it("removes owned files and never touches the mock when file creation fails midway", async () => {
        const root = tempRoot();
        const { h, api } = fakePage();
        let writes = 0;
        const fs = {
            ...nodeFs,
            writeFileSync: (...a) => {
                if (++writes === 3) throw new Error("disk full");
                return nodeFs.writeFileSync(...a);
            },
        };
        await expect(installSetupFixture(h, createSetupFixture("setup-skills", root), { fs })).rejects.toThrow(/disk full/);
        expect(api.mockClient).toBeNull();
        expect(h.scripts.some((s) => s.includes("setMockRpcClient(mock)"))).toBe(false);
        expect(existsSync(join(root, "setup-fixture-setup-skills"))).toBe(false);
    });

    it("keeps both errors when the rollback itself fails", async () => {
        const root = tempRoot();
        const { h } = fakePage({ failOn: { probe: true } });
        const fs = {
            ...nodeFs,
            rmSync: () => {
                throw new Error("EBUSY locked");
            },
        };
        const err = await installSetupFixture(h, createSetupFixture("setup-skills", root), { fs }).catch((e) => e);
        expect(err.message).toMatch(/probe failed/);
        expect(err.message).toMatch(/rollback failed: remove fixture files: EBUSY locked/);
        expect(err.errors).toHaveLength(2);
    });

    it("refuses a second install and leaves the first intact", async () => {
        const { h, api } = fakePage();
        await installSetupFixture(h, createSetupFixture("setup-skills", tempRoot()));
        const first = api.mockClient;
        await expect(installSetupFixture(h, createSetupFixture("setup-import", tempRoot()))).rejects.toThrow(/already installed/);
        expect(api.mockClient).toBe(first);
        await expect(assertSetupFixtureInstalled(h)).resolves.toBeUndefined();
    });

    it("restores the prior mock and removes its files after a thrown assertion and a missing UI", async () => {
        const prev = { mockWshRpcCall: async () => "prior" };
        const { h, api } = fakePage({ prevMock: prev });
        const ctx = await arrangeSetupFixture(h, "setup-instructions", { tmpdir: tempRoot() });
        expect(existsSync(ctx.root)).toBe(true);
        try {
            throw new Error("button 'Save & sync' not found");
        } catch {
            // the runner still tears down a context arrange returned
        }
        await teardownSetupFixture(h, ctx);
        expect(api.mockClient).toBe(prev);
        expect(existsSync(ctx.root)).toBe(false);
        await expect(assertSetupFixtureInstalled(h)).rejects.toThrow(/not intercepting/);
    });

    it("fails loudly and keeps intercepting when the prior mock cannot be restored", async () => {
        const { h, api, realCalls } = fakePage({ failOn: { restore: true } });
        const handle = await installSetupFixture(h, createSetupFixture("setup-skills", tempRoot()));
        await expect(restoreSetupFixture(h, handle)).rejects.toThrow(/restore RpcApi mock: restore refused/);
        await expect(api.call(null, "agentsyncapply", {})).resolves.toBeDefined();
        expect(realCalls).toEqual([]);
    });

    it("treats a vanished interception as a failure, not a clean restore", async () => {
        const { h, win } = fakePage();
        const handle = await installSetupFixture(h, createSetupFixture("setup-skills", tempRoot()));
        delete win.__arcSetupFixture;
        await expect(restoreSetupFixture(h, handle)).rejects.toThrow(/interception is gone/);
    });

    it("does not restore over a mock somebody else installed", async () => {
        const { h, api } = fakePage();
        const handle = await installSetupFixture(h, createSetupFixture("setup-skills", tempRoot()));
        const other = { mockWshRpcCall: async () => "other" };
        api.mockClient = other;
        await expect(restoreSetupFixture(h, handle)).rejects.toThrow(/replaced by something else/);
        expect(api.mockClient).toBe(other);
        await expect(assertSetupFixtureInstalled(h)).rejects.toThrow(/replaced/);
    });

    it("cleans its own temp root when arrange fails and keeps both errors", async () => {
        const base = tempRoot();
        const { h } = fakePage({ failOn: { probe: true } });
        const err = await arrangeSetupFixture(h, "setup-skills", { tmpdir: base }).catch((e) => e);
        expect(err.message).toMatch(/probe failed/);
        expect(existsSync(join(base, "setup-fixture-x"))).toBe(false);
        expect(nodeFs.readdirSync(base)).toEqual([]);

        const stuck = fakePage({ failOn: { probe: true } });
        const fs = {
            ...nodeFs,
            rmSync: () => {
                throw new Error("EPERM");
            },
        };
        const both = await arrangeSetupFixture(stuck.h, "setup-skills", { tmpdir: base, fs }).catch((e) => e);
        expect(both.message).toMatch(/probe failed/);
        expect(both.message).toMatch(/EPERM/);
        expect(both.errors.length).toBeGreaterThanOrEqual(2);
    });

    it("rejects unknown scenario names and a missing temp root", () => {
        expect(() => createSetupFixture("nope", tempRoot())).toThrow(/unknown setup fixture/);
        expect(() => createSetupFixture("setup-skills", "")).toThrow(/temp root/);
    });

    it("keeps the controls and snapshot behind the installed gate", async () => {
        const { h } = fakePage();
        await expect(readSetupFixture(h)).rejects.toThrow(/not intercepting/);
        await expect(controlSetupFixture(h, "resetLog")).rejects.toThrow(/not intercepting/);
    });

    it("fails only the first status read when the fault is armed after install, so the probe never eats it", async () => {
        const { h, api } = fakePage();
        await installSetupFixture(h, createSetupFixture("setup-instructions", tempRoot()));
        await controlSetupFixture(h, "fail", { command: "agentsyncstatus", message: "status unreadable", times: 1 });
        await expect(api.call(null, "agentsyncstatus", null)).rejects.toThrow(/status unreadable/);
        await expect(api.call(null, "agentsyncstatus", null)).resolves.toMatchObject({ harnesses: expect.any(Array) });
        await expect(api.call(null, "agentsyncsteeringread", null)).resolves.toBeDefined();
    });
});

function runtimeFor(name = "setup-import") {
    const fixture = createSetupFixture(name, join(tmpdir(), "unused-root"));
    const rt = createFixtureRuntime(fixture);
    const summary = () => callSummary(rt.snapshot());
    return { fixture, rt, summary };
}

const presentSteering = async (rt) =>
    (await rt.call("agentsyncstatus")).harnesses.filter((x) => x.present).map((x) => x.steering);

describe("setup fixture steering", () => {
    it("separates apply-only from save then apply", async () => {
        const { rt, summary } = runtimeFor();
        await rt.call("agentsyncapply", {});
        expect(summary()).toMatchObject({ applies: 1, applyOnly: 1, applyAfterSave: 0, diskWrites: 0 });
        const read = await rt.call("agentsyncsteeringread");
        await rt.call("agentsyncsteeringwrite", { content: "new", basemtime: read.mtime });
        await rt.call("agentsyncapply", {});
        expect(summary()).toMatchObject({ applies: 2, applyOnly: 1, applyAfterSave: 1, diskWrites: 1 });
        expect(await presentSteering(rt)).toEqual(["current", "current", "current"]);
    });

    it("reads the doc as the wire carries it: path, content, mtime", async () => {
        const { rt, fixture } = runtimeFor("setup-instructions");
        expect(await rt.call("agentsyncsteeringread")).toEqual({
            path: fixture.steering.path,
            content: fixture.steering.content,
            mtime: 1000,
        });
        rt.control("useVariant", { key: "doc-absent" });
        expect(await rt.call("agentsyncsteeringread")).toMatchObject({ content: "", mtime: 0 });
    });

    it("conflicts on a disk edit since the read, and basemtime 0 overwrites it", async () => {
        const { rt, summary } = runtimeFor();
        const read = await rt.call("agentsyncsteeringread");
        rt.control("setDisk", { content: "external edit" });
        const edited = rt.snapshot().disk;
        expect(edited.content).toBe("external edit");
        expect(edited.mtime).toBeGreaterThan(read.mtime);
        expect(await presentSteering(rt)).toEqual(["stale", "stale", "stale"]);

        const res = await rt.call("agentsyncsteeringwrite", { content: "mine", basemtime: read.mtime });
        expect(res).toEqual({ mtime: edited.mtime, conflict: true });
        expect(rt.snapshot().disk.content).toBe("external edit");
        expect(summary()).toMatchObject({ writeAttempts: 1, writeConflicts: 1, diskWrites: 0, applies: 0 });

        const forced = await rt.call("agentsyncsteeringwrite", { content: "mine", basemtime: 0 });
        expect(forced.conflict).toBe(false);
        expect(forced.mtime).toBeGreaterThan(edited.mtime);
        expect(rt.snapshot().disk.content).toBe("mine");
        expect(summary()).toMatchObject({ writeAttempts: 2, diskWrites: 1, overwriteWrites: 1 });
        expect(summary().lastWrite.data).toEqual({ content: "mine", basemtime: 0 });
    });

    it("writes a doc that is not on disk whatever the base, like WriteSteering", async () => {
        const { rt, summary } = runtimeFor();
        rt.control("setDisk", { exists: false });
        expect(await rt.call("agentsyncsteeringread")).toMatchObject({ content: "", mtime: 0 });
        const res = await rt.call("agentsyncsteeringwrite", { content: "fresh", basemtime: 1000 });
        expect(res.conflict).toBe(false);
        expect(summary()).toMatchObject({ diskWrites: 1, overwriteWrites: 0 });
    });

    it("answers an apply with no preceding save as apply-only even after a failed save", async () => {
        const { rt, summary } = runtimeFor();
        rt.control("setDisk", { content: "external" });
        await rt.call("agentsyncsteeringwrite", { content: "mine", basemtime: 1000 });
        await rt.call("agentsyncapply", {});
        expect(summary()).toMatchObject({ applyOnly: 1, applyAfterSave: 0 });
    });

    it("marks every present harness blank while the shared doc is empty", async () => {
        const { rt } = runtimeFor("setup-instructions");
        rt.control("useVariant", { key: "blank" });
        expect((await rt.call("agentsyncsteeringread")).content).toBe("");
        expect(await presentSteering(rt)).toEqual(["blank", "blank", "blank"]);
        await rt.call("agentsyncapply", {});
        expect(await presentSteering(rt)).toEqual(["blank", "blank", "blank"]);
        await rt.call("agentsyncsteeringwrite", { content: "now something", basemtime: 0 });
        await rt.call("agentsyncapply", {});
        expect(await presentSteering(rt)).toEqual(["current", "current", "current"]);
    });

    it("logs a faulted write attempt separately from disk writes and never applies", async () => {
        const { rt, summary } = runtimeFor();
        rt.control("fail", { command: "agentsyncsteeringwrite", message: "stat failed: access denied" });
        await expect(rt.call("agentsyncsteeringwrite", { content: "x", basemtime: 0 })).rejects.toThrow(/access denied/);
        expect(summary()).toMatchObject({ writeAttempts: 1, diskWrites: 0, applies: 0 });
        expect(summary().lastWrite.data).toEqual({ content: "x", basemtime: 0 });
        expect(rt.snapshot().disk.content).toContain("Shared instructions");
    });

    it("fails a read once and then serves it again", async () => {
        const { rt, summary } = runtimeFor();
        rt.control("fail", { command: "agentsyncsteeringread", message: "read failed", times: 1 });
        await expect(rt.call("agentsyncsteeringread")).rejects.toThrow(/read failed/);
        expect((await rt.call("agentsyncsteeringread")).mtime).toBe(1000);
        expect(summary()).toMatchObject({ writeAttempts: 0, applies: 0, diskWrites: 0 });
        expect(summary().reads.agentsyncsteeringread).toBe(1);
    });

    it("fails only the first status read under the status fault", async () => {
        const { rt } = runtimeFor("setup-instructions");
        rt.control("fail", { command: "agentsyncstatus", message: "status unreadable", times: 1 });
        await expect(rt.call("agentsyncstatus")).rejects.toThrow(/status unreadable/);
        expect((await rt.call("agentsyncstatus")).harnesses).toHaveLength(4);
    });

    it("surfaces independent read failures per command and clears them", async () => {
        const { rt } = runtimeFor();
        rt.control("fail", { command: "agentsyncskills", message: "skills unreadable" });
        await expect(rt.call("agentsyncskills")).rejects.toThrow(/skills unreadable/);
        await expect(rt.call("agentsyncstatus")).resolves.toBeDefined();
        rt.control("fail", { command: "agentsyncskills", message: null });
        await expect(rt.call("agentsyncskills")).resolves.toBeDefined();
    });

    it("delays an operation without changing its result", async () => {
        const { rt } = runtimeFor();
        rt.control("delay", { command: "agentsyncapply", ms: 30 });
        const t0 = Date.now();
        await rt.call("agentsyncapply", {});
        expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    });

    it("keeps a partial apply's changes after the error", async () => {
        const { rt, summary } = runtimeFor();
        rt.control("setDisk", { content: "doc" });
        rt.control("partialApply", { after: 1, message: "write to Codex failed" });
        await expect(rt.call("agentsyncapply", {})).rejects.toThrow(/Codex failed/);
        expect(await presentSteering(rt)).toEqual(["current", "stale", "stale"]);
        expect(summary().applies).toBe(1);
    });

    it("logs a faulted apply as an attempted mutation, after a save only when one preceded it", async () => {
        const { rt, summary } = runtimeFor();
        rt.control("fail", { command: "agentsyncapply", message: "apply exploded", times: 1 });
        await expect(rt.call("agentsyncapply", {})).rejects.toThrow(/apply exploded/);
        expect(summary()).toMatchObject({ applies: 1, applyErrors: 1, applyOnly: 1 });
        const read = await rt.call("agentsyncsteeringread");
        await rt.call("agentsyncsteeringwrite", { content: "n", basemtime: read.mtime });
        rt.control("fail", { command: "agentsyncapply", message: "boom" });
        await expect(rt.call("agentsyncapply", {})).rejects.toThrow(/boom/);
        expect(summary()).toMatchObject({ applies: 2, applyAfterSave: 1, applyErrors: 2 });
    });
});

const adoptPlan = (rt, data = {}) => rt.call("agentsyncadopt", { apply: false, ...data });
const unmanagedNames = (rt) => new Set(rt.snapshot().skills.unmanaged.map((m) => m.name));
const managedNames = (rt) => rt.snapshot().skills.skills.map((k) => k.name);

describe("setup fixture adopt", () => {
    it("plans every unmanaged copy and leaves a body-differing name unresolved until a keep picks a copy", async () => {
        const { rt, summary } = runtimeFor();
        const plan = await adoptPlan(rt);
        expect(plan.unresolved).toEqual(["differs-body"]);
        expect(new Set(plan.moves.map((m) => m.name))).toEqual(
            new Set(["identical-copy", "differs-body", "codex-only-skill", "fm-delta", "commit-helper"])
        );
        expect(plan.dryrun).toBeUndefined();
        expect(summary()).toMatchObject({ adoptReviews: 1, adoptApplies: 0 });
        const kept = await adoptPlan(rt, { keep: { "differs-body": "codex" } });
        expect(kept.unresolved).toEqual([]);
        expect(kept.moves.find((m) => m.name === "differs-body" && m.seed).runtime).toBe("codex");
    });

    it("moves the resolved names on apply and leaves the unresolved one and the vault skill's copy", async () => {
        const { rt, summary } = runtimeFor();
        await rt.call("agentsyncadopt", { apply: true });
        expect(unmanagedNames(rt)).toEqual(new Set(["differs-body", "commit-helper"]));
        expect(managedNames(rt)).toEqual(expect.arrayContaining(["identical-copy", "codex-only-skill", "fm-delta"]));
        expect(summary()).toMatchObject({ adoptApplies: 1, adoptAppliesMoved: 1 });
        expect(summary().lastAdoptApply).toMatchObject({ keep: {}, skip: [], apply: true });
    });

    it("skips a skipped name entirely, even one that also has a keep", async () => {
        const { rt, summary } = runtimeFor();
        const skip = ["differs-body", "identical-copy"];
        const keep = { "differs-body": "claude" };
        const plan = await adoptPlan(rt, { keep, skip });
        expect(plan.moves.some((m) => skip.includes(m.name))).toBe(false);
        expect(plan.unresolved).toEqual([]);
        // a keep naming a copy that does not exist is not checked for a skipped name either
        await expect(adoptPlan(rt, { keep: { "identical-copy": "opencode" }, skip: ["identical-copy"] })).resolves.toBeDefined();

        await rt.call("agentsyncadopt", { apply: true, keep, skip });
        const left = unmanagedNames(rt);
        expect(left.has("differs-body")).toBe(true);
        expect(left.has("identical-copy")).toBe(true);
        // both copies of each skipped name stay where they are
        expect(rt.snapshot().skills.unmanaged.filter((m) => skip.includes(m.name))).toHaveLength(4);
        expect(managedNames(rt)).not.toContain("differs-body");
        expect(managedNames(rt)).toEqual(expect.arrayContaining(["codex-only-skill", "fm-delta"]));
        expect(summary().lastAdoptApply).toMatchObject({ keep, skip });
    });

    it("rejects a runtime keep for a vault skill, a vault keep for any other name, and a keep with no copy", async () => {
        const { rt, summary } = runtimeFor();
        await expect(adoptPlan(rt, { keep: { "commit-helper": "codex" } })).rejects.toThrow(/already managed by Arc/);
        await expect(adoptPlan(rt, { keep: { "identical-copy": "vault" } })).rejects.toThrow(/holds no unmanaged copy/);
        await expect(adoptPlan(rt, { keep: { "identical-copy": "opencode" } })).rejects.toThrow(/holds no unmanaged copy/);
        await expect(rt.call("agentsyncadopt", { apply: true, keep: { "commit-helper": "codex" } })).rejects.toThrow(
            /already managed/
        );
        expect(summary().adoptRejected).toBe(1);
        expect(unmanagedNames(rt).size).toBe(5);
    });

    it("plans a vault skill's copy against the vault, never unresolved, and sets it aside only for a vault keep", async () => {
        const { rt } = runtimeFor("setup-skills");
        const shadow = (await adoptPlan(rt)).moves.filter((m) => m.name === "commit-helper");
        expect(shadow).toEqual([expect.objectContaining({ runtime: "codex", vault: true, seed: false, bodydiff: true })]);
        await rt.call("agentsyncadopt", { apply: true });
        expect(unmanagedNames(rt).has("commit-helper")).toBe(true);
        await rt.call("agentsyncadopt", { apply: true, keep: { "commit-helper": "vault" } });
        const snap = rt.snapshot();
        expect(unmanagedNames(rt).has("commit-helper")).toBe(false);
        expect(snap.skills.skills.find((k) => k.name === "commit-helper").states.codex).toBe("synced");
        expect(snap.contents.dests["commit-helper/codex"]).toBe(snap.contents.vault["commit-helper"]);
    });

    it("turns an apply into a dry run in a snapshot store and moves nothing", async () => {
        const { rt } = runtimeFor();
        rt.control("snapshotStore", { on: true });
        const res = await rt.call("agentsyncadopt", { apply: true });
        expect(res.dryrun).toBe(true);
        expect(unmanagedNames(rt).size).toBe(5);
    });

    it("compares each copy against the chosen seed, in both keep directions", async () => {
        const { rt } = runtimeFor();
        const movesFor = async (name, keep) =>
            Object.fromEntries(
                (await adoptPlan(rt, { keep })).moves.filter((m) => m.name === name).map((m) => [m.runtime, m])
            );

        const keepClaude = await movesFor("differs-body", { "differs-body": "claude" });
        expect(keepClaude.claude).toMatchObject({ seed: true, bodydiff: false });
        expect(keepClaude.codex).toMatchObject({ seed: false, bodydiff: true });
        const keepCodex = await movesFor("differs-body", { "differs-body": "codex" });
        expect(keepCodex.codex).toMatchObject({ seed: true, bodydiff: false });
        expect(keepCodex.claude).toMatchObject({ seed: false, bodydiff: true });

        // delta-only: the non-seed copy reports what it adds over the seed, and nothing when it adds nothing
        const fmClaude = await movesFor("fm-delta", { "fm-delta": "claude" });
        expect(fmClaude.claude).toMatchObject({ seed: true, bodydiff: false });
        expect(fmClaude.claude.keys).toBeUndefined();
        expect(fmClaude.codex).toMatchObject({ seed: false, bodydiff: false, keys: ["model"], files: ["agents/openai.yaml"] });
        const fmCodex = await movesFor("fm-delta", { "fm-delta": "codex" });
        expect(fmCodex.codex).toMatchObject({ seed: true, bodydiff: false });
        expect(fmCodex.claude.keys).toBeUndefined();
        expect(fmCodex.claude.files).toBeUndefined();

        // no keep: the first copy seeds, matching the listing's own flags
        const dflt = await movesFor("fm-delta", undefined);
        expect(dflt.claude.seed).toBe(true);
        expect(dflt.codex).toMatchObject({ keys: ["model"], files: ["agents/openai.yaml"] });
    });

    it("lists default-plan flags that agree with the comparison the plan makes", async () => {
        const { fixture, rt } = runtimeFor();
        const planned = (await adoptPlan(rt)).moves;
        for (const name of ["identical-copy", "fm-delta", "codex-only-skill"]) {
            const pick = (list) => list.filter((m) => m.name === name).map((m) => [m.runtime, m.bodydiff, m.keys, m.files]);
            expect(pick(planned)).toEqual(pick(fixture.skills.unmanaged));
        }
        expect((await adoptPlan(rt)).unresolved).toEqual(fixture.skills.unresolved);
    });

    it("logs a faulted adopt as an attempted mutation with its request and error", async () => {
        const { rt, summary } = runtimeFor();
        rt.control("fail", { command: "agentsyncadopt", message: "adopt exploded" });
        await expect(rt.call("agentsyncadopt", { apply: true, keep: {}, skip: ["fm-delta"] })).rejects.toThrow(
            /adopt exploded/
        );
        await expect(adoptPlan(rt)).rejects.toThrow(/adopt exploded/);
        expect(summary()).toMatchObject({ adoptApplies: 1, adoptErrors: 1, adoptReviews: 1 });
        expect(summary().lastAdoptApply).toMatchObject({ skip: ["fm-delta"], apply: true, outcome: "error", reason: "adopt exploded" });
        expect(unmanagedNames(rt).size).toBe(5);
    });

    it("keeps the rest after a partial adopt", async () => {
        const { rt } = runtimeFor();
        rt.control("partialAdopt", { after: 1, message: "move failed halfway" });
        await expect(rt.call("agentsyncadopt", { apply: true })).rejects.toThrow(/halfway/);
        expect(managedNames(rt)).toContain("identical-copy");
        expect([...unmanagedNames(rt)]).toEqual(
            expect.arrayContaining(["fm-delta", "differs-body", "codex-only-skill", "commit-helper"])
        );
    });

    it("explains a rejected adoption through the installed page runtime, not module scope", async () => {
        const { h, api } = fakePage();
        await installSetupFixture(h, createSetupFixture("setup-import", tempRoot()));
        // the page copy is built from createFixtureRuntime.toString(); a stray module reference would throw ReferenceError
        await expect(api.call(null, "agentsyncadopt", { apply: true, keep: { "commit-helper": "codex" } })).rejects.toThrow(
            /already managed/
        );
        await expect(api.call(null, "agentsyncadopt", { apply: false, keep: { ghost: "claude" } })).rejects.toThrow(
            /holds no unmanaged copy/
        );
        const snap = await readSetupFixture(h);
        expect(callSummary(snap)).toMatchObject({ adoptRejected: 1, adoptAppliesMoved: 0 });
        expect(snap.log.filter((e) => e.outcome === "rejected").every((e) => !/not defined/.test(e.reason))).toBe(true);
    });

    it("hands out skill directories that hold a SKILL.md, for every copy and the discoverable one", async () => {
        const root = tempRoot();
        const fixture = createSetupFixture("setup-import", root);
        const { h } = fakePage();
        const handle = await installSetupFixture(h, fixture);
        for (const c of fixture.skills.unmanaged) {
            expect(c.from.endsWith("SKILL.md")).toBe(false);
            expect(existsSync(join(c.from, "SKILL.md"))).toBe(true);
        }
        const rt = createFixtureRuntime(fixture);
        rt.control("discoverNew", { name: "late-arrival", runtime: "claude" });
        const late = rt.snapshot().skills.unmanaged.find((m) => m.name === "late-arrival");
        expect(existsSync(join(late.from, "SKILL.md"))).toBe(true);
        await restoreSetupFixture(h, handle);
    });
});

describe("setup fixture data", () => {
    it("reseeds a shipped body on apply, keeps its .arc deltas, and refuses a canonical edit of a shipped skill", async () => {
        const { fixture, rt } = runtimeFor("setup-skills");
        const before = rt.snapshot().contents;
        expect(before.vault["design"]).toContain("shipped body v1");
        expect(Object.keys(before.deltas).length).toBeGreaterThan(0);
        const onDisk = fixture.files.find((f) => f.path.endsWith(join("design", "SKILL.md")));
        expect(onDisk.content).toBe(before.vault["design"]);
        expect(() => rt.control("editSource", { name: "design", content: "x" })).toThrow(/not a user-owned vault skill/);
        await rt.call("agentsyncapply", {});
        const after = rt.snapshot().contents;
        expect(after.vault["design"]).toContain("shipped body v2");
        expect(after.dests["design/codex"]).toBe(after.vault["design"]);
        expect(after.dests["design/claude"]).toBeUndefined();
        expect(after.deltas).toEqual(before.deltas);
    });

    it("rewrites managed harness copies after a canonical edit and sync, and leaves the vault skill's local copy", async () => {
        const { fixture, rt } = runtimeFor("setup-skills");
        const states = (snap) => snap.skills.skills.find((k) => k.name === "commit-helper").states;
        const shadowBytes = fixture.files.find((f) => f.path.endsWith(join("codex", "skills", "commit-helper", "SKILL.md"))).content;
        expect(rt.snapshot().contents.dests["commit-helper/codex"]).toBe(shadowBytes);
        rt.control("editSource", { name: "commit-helper", content: "new body" });
        expect(states(rt.snapshot())).toEqual({ claude: "differs", codex: "unmanaged" });
        await rt.call("agentsyncapply", {});
        const after = rt.snapshot();
        expect(states(after)).toEqual({ claude: "synced", codex: "unmanaged" });
        expect(after.contents.dests["commit-helper/claude"]).toBe("new body");
        expect(after.contents.dests["commit-helper/codex"]).toBe(shadowBytes);
    });

    it("keeps body flags truthful against the files among a name's own copies", () => {
        const { fixture } = runtimeFor("setup-skills");
        const bodyOf = (path) => fixture.files.find((f) => f.path === path).content.split(/\n---\n/)[1];
        const byName = {};
        // a vault skill's copy is compared against the vault, not its siblings
        for (const c of fixture.skills.unmanaged.filter((m) => !m.vault)) (byName[c.name] ??= []).push(c);
        for (const [name, copies] of Object.entries(byName)) {
            const bodies = new Set(copies.map((c) => bodyOf(join(c.from, "SKILL.md"))));
            expect([name, copies.some((c) => c.bodydiff)]).toEqual([name, bodies.size > 1]);
        }
    });

    it("carries the current wire's fields and none of the dropped ones", () => {
        const { fixture } = runtimeFor("setup-instructions");
        const skills = fixture.skills;
        expect("piskills" in skills).toBe(false);
        expect(skills.skills.every((k) => !("sourcekind" in k) && !("sourcepath" in k))).toBe(true);
        expect(skills.linked).toEqual([expect.objectContaining({ runtime: "claude", name: "linked-tool" })]);
        expect(Object.keys(fixture.steering).sort()).toEqual(["content", "mtime", "path"]);
        const pi = fixture.status.harnesses.find((x) => x.runtime === "pi");
        expect(pi).toMatchObject({ present: true, note: "pi settings do not point at the synced skills", notetone: "warn" });
        expect(fixture.status.steeringdoc).toBe(fixture.steering.path);
    });

    it("writes each present harness's file under the temp home, with Arc's region", async () => {
        const root = tempRoot();
        const fixture = createSetupFixture("setup-instructions", root);
        const { h } = fakePage();
        const handle = await installSetupFixture(h, fixture);
        for (const row of fixture.status.harnesses) {
            expect(relative(fixture.ownedDir, row.path).startsWith("..")).toBe(false);
            expect(existsSync(row.path)).toBe(row.present);
        }
        const claude = fixture.status.harnesses.find((x) => x.runtime === "claude");
        const text = readFileSync(claude.path, "utf8");
        expect(text).toContain("ARC-STEERING:BEGIN");
        expect(text).toContain("Prefer small diffs.");
        expect(text).toContain("My own claude notes");
        expect(claude.path.endsWith(join(".claude", "CLAUDE.md"))).toBe(true);
        await restoreSetupFixture(h, handle);
        expect(existsSync(claude.path)).toBe(false);
    });

    it("renders each variant's dataset", async () => {
        const { rt } = runtimeFor("setup-instructions");
        rt.control("useVariant", { key: "long-token" });
        const doc = (await rt.call("agentsyncsteeringread")).content;
        expect(doc.trim()).toBe(LONG_TOKEN);
        expect(LONG_TOKEN).toHaveLength(200);
        expect(/\s/.test(LONG_TOKEN)).toBe(false);
        rt.control("useVariant", { key: "no-skills" });
        expect((await rt.call("agentsyncskills")).skills).toEqual([]);
        rt.control("useVariant", { key: "unavailable-column" });
        expect((await rt.call("agentsyncskills")).columns.every((c) => !c.present)).toBe(true);
        expect(() => rt.control("useVariant", { key: "nope" })).toThrow(/unknown variant/);
        expect(() => rt.control("nope")).toThrow(/unknown control/);
    });

    it("keeps every source file under the fixture's own temp folder and removes only that folder", async () => {
        const root = tempRoot();
        const sibling = join(root, "keep-me.txt");
        writeFileSync(sibling, "mine");
        const fixture = createSetupFixture("setup-skills", root);
        for (const f of fixture.files) {
            expect(relative(fixture.ownedDir, f.path).startsWith("..")).toBe(false);
        }
        const { h } = fakePage();
        const handle = await installSetupFixture(h, fixture);
        const source = join(fixture.skills.skillsroot, "commit-helper", "SKILL.md");
        expect(readFileSync(source, "utf8")).toContain("commit-helper vault source body");
        expect(source.startsWith(root)).toBe(true);
        await restoreSetupFixture(h, handle);
        expect(existsSync(source)).toBe(false);
        expect(existsSync(fixture.ownedDir)).toBe(false);
        expect(existsSync(sibling)).toBe(true);
        expect(existsSync(root)).toBe(true);
    });

    it("refuses a fixture file outside its own folder", async () => {
        const root = tempRoot();
        const fixture = createSetupFixture("setup-skills", root);
        fixture.files.push({ path: join(root, "..", "escaped.md"), content: "x" });
        const { h } = fakePage();
        await expect(installSetupFixture(h, fixture)).rejects.toThrow(/outside its temporary folder/);
        expect(h.scripts).toEqual([]);
    });

    it("keeps the page-visible state to the fixture's own runtime", async () => {
        const { h, win } = fakePage();
        await installSetupFixture(h, createSetupFixture("setup-skills", tempRoot()));
        const snap = await readSetupFixture(h);
        expect(Object.keys(snap).sort()).toEqual(["contents", "controls", "disk", "log", "diskWrites", "skills", "status"].sort());
        expect(Object.keys(win).sort()).toEqual(["TabRpcClient", "__arcSetupFixture"]);
    });
});

