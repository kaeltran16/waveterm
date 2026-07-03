// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atom, type PrimitiveAtom } from "jotai";

// Non-null while a leader sequence is in progress; drives the which-key bar.
// Cast per this repo's convention: atom<T | null>(null) infers a read-only Atom under the pinned
// jotai types, so nullable primitives are cast to PrimitiveAtom (see agents.tsx focusIdAtom).
export const activeLeaderAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
