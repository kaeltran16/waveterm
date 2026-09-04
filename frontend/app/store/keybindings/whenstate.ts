// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Some binding `when(ctx)` predicates (bindings.ts) read state KeyContext does not carry — e.g. the
// Diff surface's compare/filter posture — because ctx is only what the dispatcher needs and a
// predicate is free to read anything live via globalStore. The dispatcher never goes stale from this:
// it re-derives ctx and re-evaluates every predicate on every keydown. A reactive consumer that only
// re-renders on atom subscriptions — the hints footer — has nothing to subscribe to for that state.
//
// Rather than have the footer enumerate those atoms itself (coupling it to whatever a predicate
// happens to read today, so the same staleness returns the next time a predicate is added over a new
// one), watch them here, once, and expose a single version counter. New predicate-only state joins
// PREDICATE_ATOMS below; the footer never changes. Subscribing to the atom itself, not wrapping its
// setters, means every writer is covered automatically — including one outside the atom's own module
// (filessurface.tsx flips diffScopeAtom directly when the picker jumps to a different agent, without
// going through comparestore.ts's enterCompare/leaveCompare). See docs/open-issues.md, "Hints-footer
// staleness".
//
// PREDICATE_ATOMS is hand-maintained — it has to be, since deriving it automatically would mean
// changing every when(ctx) predicate to read through a tracked `get` instead of globalStore.get, which
// is a much larger change than this bug warrants. The risk that creates (an atom added to a predicate
// without a matching entry here) is caught mechanically, not by memory: store.test.ts's "PREDICATE_ATOMS
// completeness" test evaluates every registered predicate's when() over a full KeyContext sweep with
// globalStore.get instrumented, and fails if a predicate reads an atom this list doesn't have, or if
// this list has an atom no predicate reads. Keep that test passing rather than trusting this comment.

import { globalStore } from "@/app/store/jotaiStore";
import { compareOnAtom } from "@/app/view/agents/comparestore";
import { historyFiltersAtom } from "@/app/view/agents/githistorystore";
import { renamingRowAtom } from "@/app/view/agents/rowrenameatom";
import { focusSubagentAtom } from "@/app/view/agents/subagentsstore";
import { codeFinderOpenAtom, codeTreeFocusedAtom } from "@/app/view/code/codestore";
import { autonomyPanelOpenAtom } from "@/app/view/jarvis/autonomyladder";
import { graphPeekOpenAtom } from "@/app/view/jarvis/jarvisstore";
import { petPeekOpenAtom } from "@/app/view/jarvis/petstore";
import { atom, type Atom, type PrimitiveAtom } from "jotai";
import { listNavAtom } from "./listnav";

export const whenVersionAtom = atom(0) as PrimitiveAtom<number>;

// Every atom reachable from a when(ctx) predicate's evaluation in bindings.ts, direct or through a
// shared helper (e.g. onStage, inCompare, inTree) — audited against every `globalStore.get(...)` call
// site in that file and cross-checked by the completeness test described above.
export const PREDICATE_ATOMS: Atom<unknown>[] = [
    compareOnAtom, // buildFilesBindings: on/inCompare/inHistory/filtering, surface:back-home
    historyFiltersAtom, // buildFilesBindings: filtering, surface:back-home
    graphPeekOpenAtom, // buildJarvisBindings: onStage, surface:back-home
    autonomyPanelOpenAtom, // surface:back-home
    petPeekOpenAtom, // surface:back-home
    codeFinderOpenAtom, // surface:back-home
    codeTreeFocusedAtom, // buildCodeBindings: inTree
    listNavAtom, // buildListNavBindings: active
    renamingRowAtom, // buildAgentBindings: subagent:back
    focusSubagentAtom, // buildAgentBindings: subagent:back, agent:back
];

for (const predicateAtom of PREDICATE_ATOMS) {
    globalStore.sub(predicateAtom, () => {
        globalStore.set(whenVersionAtom, (v) => v + 1);
    });
}
