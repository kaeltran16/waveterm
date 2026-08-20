// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import type { DagDraftRequest } from "@/app/view/agents/composercommand";
import { atom, type PrimitiveAtom } from "jotai";

export type DagDecomposingState = {
    kind: "decomposing";
    request: DagDraftRequest;
    error: string;
};

export const dagModalStateAtom = atom<DagDecomposingState | null>(null) as PrimitiveAtom<DagDecomposingState | null>;

export function openDagDraft(request: DagDraftRequest): void {
    globalStore.set(dagModalStateAtom, { kind: "decomposing", request, error: "" });
}
