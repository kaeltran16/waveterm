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

import { globalStore } from "@/app/store/jotaiStore";
import { compareOnAtom } from "@/app/view/agents/comparestore";
import { historyFiltersAtom } from "@/app/view/agents/githistorystore";
import { atom, type Atom, type PrimitiveAtom } from "jotai";

export const whenVersionAtom = atom(0) as PrimitiveAtom<number>;

const PREDICATE_ATOMS: Atom<unknown>[] = [compareOnAtom, historyFiltersAtom];

for (const predicateAtom of PREDICATE_ATOMS) {
    globalStore.sub(predicateAtom, () => {
        globalStore.set(whenVersionAtom, (v) => v + 1);
    });
}
