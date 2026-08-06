// frontend/app/view/code/codesearchstore.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Content-search state for the Code surface. Its own module rather than more of codestore.ts, which
// is already 325 lines and owns a different concern (the file index and the open buffer).
//
// It deliberately imports nothing from codestore: runSearch takes the project as an argument, so
// codestore can import resetSearch to clear this on a project switch without an import cycle.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";

// One union rather than parallel loading/error booleans, for the same reason CodeFile is one: the
// pane renders an exhaustive switch and cannot land in a contradictory pair of states.
export type SearchState =
    | { kind: "idle" }
    | { kind: "searching"; query: string }
    | { kind: "done"; query: string; matches: GitGrepMatch[]; truncated: boolean }
    | { kind: "error"; query: string; message: string };

export const codeSearchModeAtom = atom<"files" | "search">("files") as PrimitiveAtom<"files" | "search">;
export const codeSearchQueryAtom = atom<string>("") as PrimitiveAtom<string>;
export const codeSearchAtom = atom<SearchState>({ kind: "idle" }) as PrimitiveAtom<SearchState>;

// The RPC layer's DefaultTimeoutMs is 5s and it binds the SERVER-side context, so a search the
// server would have finished gets killed under it. The reader self-limits at gitinfo's 10s
// gitTimeout; this ceiling sits above that so git's own limit is the one that decides.
const GREP_RPC_TIMEOUT_MS = 20_000;

// guards a slow search against a newer one, same pattern as codestore's index and file loads
const current = { token: "" };

export async function runSearch(project: { path: string }, query: string): Promise<void> {
    const q = query.trim();
    if (q === "") {
        globalStore.set(codeSearchAtom, { kind: "idle" });
        return;
    }
    const token = `${project.path}|${q}`;
    current.token = token;
    globalStore.set(codeSearchAtom, { kind: "searching", query: q });
    try {
        const res = await RpcApi.GitGrepCommand(
            TabRpcClient,
            { cwd: project.path, query: q },
            { timeout: GREP_RPC_TIMEOUT_MS }
        );
        if (current.token !== token) {
            return;
        }
        globalStore.set(codeSearchAtom, {
            kind: "done",
            query: q,
            matches: res.matches ?? [],
            truncated: res.truncated ?? false,
        });
    } catch (e) {
        if (current.token !== token) {
            return;
        }
        // a failed RPC is an error, not an empty repository — the same distinction the index load makes
        globalStore.set(codeSearchAtom, {
            kind: "error",
            query: q,
            message: e instanceof Error ? e.message : String(e),
        });
    }
}

export function resetSearch(): void {
    current.token = "";
    globalStore.set(codeSearchQueryAtom, "");
    globalStore.set(codeSearchAtom, { kind: "idle" });
    globalStore.set(codeSearchModeAtom, "files");
}
