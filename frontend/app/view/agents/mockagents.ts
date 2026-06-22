// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// DEV-ONLY throwaway roster for eyeballing the Agents view (all states at once) without a live
// reporter. Wired in via AgentsViewModel only under import.meta.env.DEV && USE_MOCK_AGENTS.
// Narration lives in previousInfo so panels render without a transcript stream; transcriptPath is
// intentionally omitted so the stream effect never fires for these fake blocks.

import { atom } from "jotai";
import type { AgentEntry, AgentVM } from "./agentsviewmodel";

export const USE_MOCK_AGENTS = false;

const NOW = Date.now();

const detectorNarration: AgentEntry[] = [
    { kind: "message", text: "Validated the committed #39 entropy detector against PROD M0001." },
    { kind: "action", verb: "ran", target: "go test ./pkg/detect/...", outcome: "ok" },
    { kind: "action", verb: "edited", target: "entropy_detector.go", outcome: "ok" },
    { kind: "message", text: "Both PROD-groundable now; #40 DNS-tunneling is the highest net-new value." },
];

const waveNarration: AgentEntry[] = [
    { kind: "user", text: "fix the windows packaging backend gotcha" },
    { kind: "action", verb: "ran", target: "task package", outcome: "ok" },
    { kind: "action", verb: "read", target: "electron-builder.config.cjs" },
    { kind: "message", text: "asarUnpack maps dist/bin/**; verifying the packaged backend now." },
];

const graphifyNarration: AgentEntry[] = [
    { kind: "message", text: "Clustering 1031 nodes into communities." },
    { kind: "action", verb: "ran", target: "louvain pass", outcome: "ok" },
];

const scribeNarration: AgentEntry[] = [
    { kind: "message", text: "Drafted release notes for 0.14.5." },
    { kind: "action", verb: "wrote", target: "CHANGELOG.md", outcome: "ok" },
    { kind: "message", text: "Done — ready for your review." },
];

export const mockAgentsAtom = atom<AgentVM[]>([
    {
        id: "mock-ask-1",
        name: "siem-detector",
        task: "Entropy detector for SIEM-1662",
        state: "asking",
        model: "opus",
        blockedMs: 180_000,
        blockId: "mock-blk-1",
        usage: {
            contextpct: 84,
            contextmax: 200000,
            costusd: 4.2,
            fivehourpct: 62,
            fivehourreset: Math.floor(NOW / 1000) + 7860,
            weekpct: 34,
            weekreset: Math.floor(NOW / 1000) + 342000,
        },
        previousInfo: detectorNarration,
        ask: {
            askId: "a1",
            oref: "block:mock-blk-1",
            questions: [
                {
                    header: "NEXT TRACK",
                    question: "Which track should I take next on SIEM-1662?",
                    options: [
                        {
                            label: "finalize #39 + build #40 (Recommended)",
                            description: "validate committed #39, extend the skeleton to #40 DNS-tunneling",
                        },
                        { label: "Prep the SOC batch", description: "assemble #18/#23/#39/#40 into one ask" },
                        { label: "Consolidate & commit", description: "close catalog drift, commit doc work" },
                    ],
                },
            ],
        },
    },
    {
        id: "mock-ask-2",
        name: "loom",
        task: "Refactor duplicate-session race",
        state: "asking",
        model: "sonnet",
        blockedMs: 240_000,
        blockId: "mock-blk-2",
        previousInfo: [{ kind: "message", text: "Found the race in the session reaper. Need scope before merge." }],
        ask: {
            askId: "a2",
            oref: "block:mock-blk-2",
            questions: [
                {
                    header: "PRE-MERGE",
                    question: "Which checks should I run before merging? (pick any)",
                    multiSelect: true,
                    options: [
                        { label: "unit" },
                        { label: "integration" },
                        { label: "lint" },
                        { label: "typecheck" },
                    ],
                },
            ],
        },
    },
    {
        id: "mock-ask-3",
        name: "obsidian",
        task: "Vault sync conflict",
        state: "asking",
        model: "haiku",
        blockedMs: 90_000,
        blockId: "mock-blk-3",
        ask: {
            askId: "a3",
            oref: "block:mock-blk-3",
            questions: [
                {
                    question: "Keep local or remote version of the daily note?",
                    options: [{ label: "Keep local" }, { label: "Keep remote" }],
                },
            ],
        },
    },
    {
        id: "mock-work-1",
        name: "waveterm",
        task: "Windows packaging fix",
        state: "working",
        model: "sonnet",
        activeMs: 120_000,
        blockId: "mock-blk-4",
        usage: { contextpct: 71, contextmax: 200000, costusd: 2.1 },
        previousInfo: waveNarration,
    },
    {
        id: "mock-work-2",
        name: "graphify",
        task: "Cluster communities",
        state: "working",
        model: "haiku",
        activeMs: 45_000,
        blockId: "mock-blk-5",
        previousInfo: graphifyNarration,
    },
    {
        id: "mock-idle-1",
        name: "scribe",
        task: "Draft release notes",
        state: "idle",
        model: "opus",
        activeMs: 300_000,
        idleSince: NOW - 30_000, // within the 5m grace -> renders as a panel with a Dismiss button
        blockId: "mock-blk-6",
        usage: { contextpct: 61, contextmax: 200000, costusd: 1.8 },
        previousInfo: scribeNarration,
    },
    {
        id: "mock-idle-2",
        name: "janitor",
        task: "",
        state: "idle",
        activity: "stopped without asking",
        idleSince: NOW - 600_000, // past grace -> collapsed Idle section
        blockId: "mock-blk-7",
    },
]);
