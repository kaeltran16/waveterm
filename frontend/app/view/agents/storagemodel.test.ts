// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { storageScenarios } from "./storagefixtures";
import {
    CLEAR_LEAD,
    CLEAR_TAIL,
    clearButton,
    clearPlan,
    deletePlan,
    navSummary,
    pollWanted,
    rescanEnabled,
    resultNotice,
    scanErrorText,
    scannedLabel,
    shouldAutoScan,
    storageSections,
    storageStats,
    type StorageRowVM,
} from "./storagemodel";

// the canvas's sample machine: 2026-10-14 at 09:40, local time
const NOW = new Date(2026, 9, 14, 9, 40).getTime();
const S = storageScenarios(NOW);
const SKIPPED = ".waveterm\\worktrees\\9e473bf8";

function rows(r: StorageReportData): StorageRowVM[] {
    return storageSections(r, NOW).flatMap((s) => s.rows);
}

function row(r: StorageReportData, path: string): StorageRowVM {
    const found = rows(r).find((w) => w.path === path);
    expect(found, path).toBeDefined();
    return found;
}

function item(r: StorageReportData, shortPath: string): StorageItem {
    return r.items.find((it) => it.id === row(r, shortPath).id);
}

const text = (parts: { text: string }[]) => parts.map((p) => p.text).join("");

describe("storage (board Main)", () => {
    it("lists three sections with 11 Left over rows", () => {
        const sections = storageSections(S.storage, NOW);
        expect(sections.map((s) => [s.group, s.title, s.meta])).toEqual([
            ["left", "Left over", "its run finished, or no run owns it"],
            ["inuse", "In use", "a run is working in it"],
            ["kept", "Kept on purpose", "caches and history Arc reads"],
        ]);
        expect(sections.map((s) => s.rows.length)).toEqual([11, 1, 7]);
    });
    it("orders Left over by kind then newest, and Kept by size", () => {
        const [left, , kept] = storageSections(S.storage, NOW);
        expect(left.rows.map((w) => w.path)).toEqual([
            "arc-wt\\bd67b1fe",
            "arc-wt\\3425249d",
            "arc-wt\\009152b3",
            "arc-wt\\866e3b50",
            "arc-wt\\a6cf3f86",
            ".waveterm\\worktrees (16)",
            SKIPPED,
            "wave/f15cd1a3",
            "wave/021cb57c",
            "Temp\\arc-final-* (21)",
            "arc-final-out-* (2)",
        ]);
        expect(kept.rows.map((w) => w.path)).toEqual([
            "arc-final\\target",
            "arc-final\\target-1",
            "arc-final\\target-2",
            ".claude\\projects",
            "data\\final-shots (31)",
            ".pi",
            "arc-final\\stores-* (2)",
        ]);
    });
    it("shows the stat tiles, the Clear button and the nav summary", () => {
        expect(storageStats(S.storage)).toEqual([
            { group: "left", label: "Left over", value: "363 MB", sub: "11 items" },
            { group: "inuse", label: "In use", value: "51 MB", sub: "1 live run" },
            { group: "kept", label: "Kept on purpose", value: "14.2 GB", sub: "7 items · caches and history" },
        ]);
        expect(clearButton(S.storage)).toEqual({ show: true, enabled: true, label: "Clear 314 MB left over" });
        expect(rescanEnabled(S.storage)).toBe(true);
        expect(navSummary(S.storage)).toEqual({ count: "14.6 GB", pill: "363 MB left over" });
        expect(scannedLabel(S.storage, NOW)).toBe("scanned 09:40");
        expect(resultNotice(S.storage)).toBeNull();
        expect(pollWanted(S.storage)).toBe(false);
    });
    it("tags the checkout with unique commits as skipped, with Delete anyway", () => {
        const w = row(S.storage, SKIPPED);
        expect(w.tag).toEqual({ text: "Clear skips it", tone: "muted" });
        expect(w.canDelete).toBe(true);
        expect(w.kind).toBe("checkout, old in-project layout · clean");
        expect(w.owner).toBe("Finish the user notes feature: chunks 8, 9 and 10");
        expect(w.ownerMeta).toBe("waveterm · cancelled 10-08");
        expect(w.loses).toBe("2 commits only on wave/9e473bf8");
        expect(w.losesMuted).toBe(false);
        expect(rows(S.storage).filter((x) => x.canDelete)).toHaveLength(1);
    });
    it("words the rows as the canvas does", () => {
        const landed = row(S.storage, "arc-wt\\bd67b1fe");
        expect(landed).toMatchObject({
            kind: "landing tree, emptied · not in git",
            owner: "Investigation engine leak-check escape fix",
            ownerMeta: "cyber_anomaly_detector · landed 09:31",
            size: "8 KB",
            idle: "9m",
            loses: "Nothing",
            losesMuted: true,
            tag: null,
            canDelete: false,
        });
        expect(row(S.storage, "arc-wt\\009152b3").ownerMeta).toBe("waveterm · landed 10-13");
        expect(row(S.storage, ".waveterm\\worktrees (16)")).toMatchObject({
            kind: "old in-project trees, emptied · not in git",
            owner: "16 finished runs",
            ownerMeta: "waveterm · before 10-12",
            size: "192 KB",
            idle: "3d+",
            run: null,
        });
        expect(row(S.storage, "wave/021cb57c")).toMatchObject({
            kind: "branch only, no folder",
            ownerMeta: "cyber_anomaly_detector · cancelled 09-30",
            size: "—",
            barPct: 0,
            loses: "Nothing: every commit is also on SIEM-1707_anomaly-hypothesis-system-backup-20261001",
            losesMuted: true,
        });
        expect(row(S.storage, "wave/f15cd1a3")).toMatchObject({
            kind: "branch only · held land you dismissed",
            ownerMeta: "cyber_anomaly_detector · held 10-06",
        });
        expect(row(S.storage, "Temp\\arc-final-* (21)")).toMatchObject({
            kind: "Final outputs from hand-run Finals",
            owner: "No run",
            ownerMeta: "final-verify.mjs run by hand",
            size: "208 MB",
            run: null,
        });
        expect(row(S.storage, "arc-wt\\dca34385")).toMatchObject({
            kind: "landing tree · in git",
            ownerMeta: "waveterm · executing",
            idle: "now",
            loses: "The run’s work in progress",
            run: { kind: "run", runId: "dca34385-7b2e-4c1a-9f3d-2e8b6a1c4d70" },
        });
        expect(row(S.storage, "arc-final\\target")).toMatchObject({
            kind: "Final build slot 0 · warm cargo target",
            owner: "Final stage",
            ownerMeta: "shared by every run’s Final",
            size: "4.1 GB",
            barPct: 100,
            idle: "15d",
            loses: "The next Final on slot 0 builds the app cold",
        });
        expect(row(S.storage, ".claude\\projects")).toMatchObject({ owner: "Claude Code", idle: "—" });
        expect(row(S.storage, ".pi")).toMatchObject({ owner: "pi", kind: "pi sessions and config", idle: "—" });
        expect(row(S.storage, "data\\final-shots (31)")).toMatchObject({
            kind: "Final screenshots of 31 runs · kept 30 days",
            idle: "—",
            loses: "Those runs’ Final steps stop opening their screenshots",
        });
        expect(row(S.storage, "arc-final\\stores-* (2)")).toMatchObject({ idle: "2d+", loses: "Nothing" });
    });
});

describe("clearPlan (board Confirm)", () => {
    it("counts member folders, lists what it skips, and sums the clearable rows", () => {
        const plan = clearPlan(S.storage);
        expect(plan.title).toBe("Clear 314 MB left over?");
        expect(plan.lead).toBe(CLEAR_LEAD);
        expect(plan.lead).toBe("Deletes what no run needs and loses nothing:");
        expect(plan.lines).toEqual([
            "21 empty run folders",
            "2 wave branches whose commits are on other branches",
            "23 output folders of Finals run by hand",
        ]);
        expect(plan.skipped).toEqual([{ path: SKIPPED, reason: "2 commits are only on its branch." }]);
        expect(plan.tail).toBe(CLEAR_TAIL);
        expect(plan.tail).toBe("Live runs and kept items are never touched.");
        expect(plan.ids).toHaveLength(10);
        expect(plan.ids).not.toContain(row(S.storage, SKIPPED).id);
    });
    it("drops a line whose count is 0", () => {
        const onlyBranches = { ...S.storage, items: S.storage.items.filter((it) => it.kind === "branch") };
        expect(clearPlan(onlyBranches).lines).toEqual(["2 wave branches whose commits are on other branches"]);
    });
});

describe("deletePlan (board DeleteOne)", () => {
    it("a checkout with its branch", () => {
        const plan = deletePlan(item(S.storage, SKIPPED));
        expect(plan.title).toBe("Delete 9e473bf8 and its branch?");
        expect(text(plan.lead)).toBe(
            "Deletes the checkout .waveterm\\worktrees\\9e473bf8 (49 MB) and the branch wave/9e473bf8. These 2 commits are on no other branch and are lost for good:"
        );
        expect(plan.lead.filter((p) => p.strong).map((p) => p.text)).toEqual([SKIPPED, "wave/9e473bf8"]);
        expect(plan.commits).toEqual([
            { sha: "ad962fe1", subject: "docs: drop the notes palette plan from this run" },
            { sha: "01a08218", subject: "docs: spec and plan for User notes in the palette" },
        ]);
        expect(plan.dirtyLine).toBeNull();
        expect(plan.cta).toBe("Delete and lose 2 commits");
    });
    it("a branch-only row", () => {
        const plan = deletePlan({
            id: "branch:p:refs/heads/wave/77aa11bb-0000-4000-8000-000000000000",
            kind: "branch",
            group: "left",
            branch: "wave/77aa11bb-0000-4000-8000-000000000000",
            onlycount: 3,
            onlycommits: [{ sha: "aaaa1111", subject: "feat: a" }],
            size: 0,
            skip: "commits",
        });
        expect(plan.title).toBe("Delete wave/77aa11bb?");
        expect(text(plan.lead)).toBe(
            "Deletes the branch wave/77aa11bb. These 3 commits are on no other branch and are lost for good:"
        );
        expect(plan.cta).toBe("Delete and lose 3 commits");
    });
    it("a dirty checkout with no unique commits", () => {
        const plan = deletePlan({
            id: "legacytree:C:\\p\\.waveterm\\worktrees\\5c5c5c5c-0000-4000-8000-000000000000",
            kind: "legacytree",
            group: "left",
            path: "C:\\p\\.waveterm\\worktrees\\5c5c5c5c-0000-4000-8000-000000000000",
            branch: "wave/5c5c5c5c-0000-4000-8000-000000000000",
            tracked: true,
            hasgit: true,
            dirty: 4,
            size: 2 * 1024 * 1024,
            skip: "dirty",
        });
        expect(plan.title).toBe("Delete 5c5c5c5c and its branch?");
        expect(text(plan.lead)).toBe(
            "Deletes the checkout .waveterm\\worktrees\\5c5c5c5c (2 MB) and the branch wave/5c5c5c5c."
        );
        expect(plan.commits).toEqual([]);
        expect(plan.dirtyLine).toBe("Its 4 uncommitted files are lost for good.");
        expect(plan.cta).toBe("Delete and lose 4 uncommitted files");
    });
    it("names both losses when a checkout has unique commits and uncommitted files", () => {
        const both = { ...item(S.storage, SKIPPED), dirty: 1, skip: "dirty" };
        expect(deletePlan(both).cta).toBe("Delete and lose 2 commits and 1 uncommitted file");
        expect(deletePlan(both).dirtyLine).toBe("Its 1 uncommitted file is lost for good.");
    });
});

describe("states", () => {
    it("clearing: progress on the button, row tags, no Delete anyway, no Rescan", () => {
        expect(clearButton(S.clearing)).toEqual({ show: true, enabled: false, label: "Clearing 7 of 10…" });
        expect(rescanEnabled(S.clearing)).toBe(false);
        expect(pollWanted(S.clearing)).toBe(true);
        const all = rows(S.clearing);
        expect(all.some((w) => w.canDelete)).toBe(false);
        expect(all.filter((w) => w.tag?.text === "Cleared")).toHaveLength(6);
        expect(all.filter((w) => w.tag?.text === "Clearing…").map((w) => [w.path, w.tag.tone])).toEqual([
            ["wave/f15cd1a3", "accent"],
        ]);
        expect(row(S.clearing, SKIPPED).tag).toEqual({ text: "Clear skips it", tone: "muted" });
        expect(resultNotice(S.clearing)).toBeNull();
    });
    it("cleared: the notice names the held folder and that row says why", () => {
        expect(resultNotice(S.cleared)).toEqual({
            text: "Cleared 9 items, 314 MB freed.",
            failure: "1 couldn’t be cleared",
            failureWhy: "a process still has arc-wt\\3425249d open.",
        });
        const held = row(S.cleared, "arc-wt\\3425249d");
        expect(held.tag).toEqual({ text: "In use by a process", tone: "error" });
        expect(held.loses).toBe(
            "Couldn’t clear: a process has it open. Close the terminal or editor in it, then clear again."
        );
        expect(held.losesMuted).toBe(false);
        expect(clearButton(S.cleared)).toEqual({ show: true, enabled: true, label: "Clear again" });
        expect(storageStats(S.cleared)[0]).toMatchObject({ value: "49 MB", sub: "2 items" });
        expect(navSummary(S.cleared)).toEqual({ count: "14.3 GB", pill: "49 MB left over" });
        expect(row(S.cleared, SKIPPED).canDelete).toBe(true);
    });
    it("scanning: pending stats, no sections, no Clear, polling", () => {
        expect(storageStats(S.scanning).map((t) => [t.value, t.sub])).toEqual([
            ["…", "scanning"],
            ["…", "scanning"],
            ["…", "scanning"],
        ]);
        expect(storageSections(S.scanning, NOW)).toEqual([]);
        expect(clearButton(S.scanning).show).toBe(false);
        expect(rescanEnabled(S.scanning)).toBe(false);
        expect(pollWanted(S.scanning)).toBe(true);
        expect(scannedLabel(S.scanning, NOW)).toBe("scanning…");
        expect(navSummary(S.scanning)).toEqual({ count: "…", pill: null });
    });
    it("a Rescan with a result keeps Clear shown but disabled", () => {
        const rescan = { ...S.storage, scanning: true };
        expect(clearButton(rescan)).toEqual({ show: true, enabled: false, label: "Clear 314 MB left over" });
        expect(storageSections(rescan, NOW)).toHaveLength(3);
        expect(rows(rescan).some((w) => w.canDelete)).toBe(false);
    });
    it("error: the banner names the project and its rows are left out", () => {
        expect(S.error.errors.map(scanErrorText)).toEqual([
            "Couldn’t list the run trees of cyber_anomaly_detector: git exited 128, not a git repository. Its folders are left out until the project path is fixed.",
        ]);
        const all = rows(S.error);
        expect(all.some((w) => (w.ownerMeta + w.full).includes("cyber_anomaly_detector"))).toBe(false);
        expect(storageSections(S.error, NOW)[0].rows).toHaveLength(7);
    });
    it("clean: no Clear, an empty Left over, no pill", () => {
        expect(clearButton(S.clean).show).toBe(false);
        expect(storageSections(S.clean, NOW)[0].rows).toEqual([]);
        expect(storageStats(S.clean)[0]).toMatchObject({ value: "0 B", sub: "nothing to clear" });
        expect(navSummary(S.clean).pill).toBeNull();
    });
});

describe("auto-scan and polling", () => {
    it("scans on open only when loaded with no result and no job", () => {
        expect(shouldAutoScan(null)).toBe(false);
        expect(shouldAutoScan({ scants: 0, items: [] })).toBe(true);
        expect(shouldAutoScan(S.scanning)).toBe(false);
        expect(shouldAutoScan(S.storage)).toBe(false);
        expect(pollWanted(null)).toBe(false);
        expect(navSummary(null)).toEqual({ count: "…", pill: null });
    });
});
