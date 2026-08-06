// frontend/app/view/agents/diffscopeatom.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Diff surface's stored subject. In its own module, not on the view model, because the git stores
// need to read and write it and must not depend on a React view model. Module scope is also what lets
// the scope survive the surface unmounting on a nav switch.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, type PrimitiveAtom } from "jotai";
import { rangeKey, type DiffRange, type DiffScope } from "./diffscope";

export const diffScopeAtom = atom<DiffScope | null>(null) as PrimitiveAtom<DiffScope | null>;

export function setDiffRange(range: DiffRange): void {
    const scope = globalStore.get(diffScopeAtom);
    if (scope == null || rangeKey(scope.range) === rangeKey(range)) {
        return;
    }
    globalStore.set(diffScopeAtom, { ...scope, range });
}
