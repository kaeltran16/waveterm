// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({ AgentDocsCommand: vi.fn(), GetAgentTranscriptCommand: vi.fn() }));
const wos = vi.hoisted(() => ({ loadAndPinWaveObject: vi.fn(), makeORef: (t: string, id: string) => `${t}:${id}` }));

vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: rpc }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wos", () => wos);

import type { AgentVM } from "./agentsviewmodel";
import { besideTabFor } from "./workspacedocsstore";

const CWD = "C:\\repo";
const SPEC = "C:\\repo\\docs\\specs\\a-design.md";

let seq = 0;
const agent = (): AgentVM => ({
    id: `docs-${++seq}`,
    name: "a",
    task: "",
    state: "idle",
    agent: "claude",
    blockId: `block-${seq}`,
    transcriptPath: "C:\\t\\s.jsonl",
});

beforeEach(() => {
    rpc.AgentDocsCommand.mockReset();
    rpc.AgentDocsCommand.mockResolvedValue({ docs: [{ path: SPEC, ts: 1, verb: "written" }] });
    wos.loadAndPinWaveObject.mockReset();
    wos.loadAndPinWaveObject.mockResolvedValue({ meta: { "cmd:cwd": CWD } });
});

describe("besideTabFor", () => {
    it.each([
        {
            name: "a listed doc cited by a cwd-relative path opens the Docs tab on it",
            file: { path: "docs/specs/a-design.md", line: null },
            want: { kind: "docs", selected: SPEC },
        },
        {
            name: "Markdown the agent did not write opens the File tab, line kept",
            file: { path: "docs/other.md", line: 4 },
            want: { kind: "file", path: "docs/other.md", line: 4 },
        },
        {
            name: "a .go file opens the File tab, line kept",
            file: { path: "pkg/a.go", line: 12 },
            want: { kind: "file", path: "pkg/a.go", line: 12 },
        },
    ])("$name", async ({ file, want }) => {
        expect(await besideTabFor(agent(), file)).toEqual(want);
    });

    it("re-reads the list at the click, so a doc written since the last read is found", async () => {
        const a = agent();
        rpc.AgentDocsCommand.mockResolvedValueOnce({ docs: [] });
        expect((await besideTabFor(a, { path: SPEC, line: null })).kind).toBe("file");
        expect(await besideTabFor(a, { path: SPEC, line: null })).toEqual({ kind: "docs", selected: SPEC });
    });
});
