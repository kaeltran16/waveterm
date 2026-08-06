// frontend/app/view/agents/rowrenameatom.ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Which session row is currently being renamed in place (its tabId), or null. In its own module for
// the same reason diffScopeAtom is: the keybinding registry has to read it and must not depend on a
// React view model. One atom rather than per-row component state, for two reasons — renaming two rows
// at once is meaningless (starting one closes the other for free), and an open rename box has to be
// visible to the Escape binding that would otherwise steal the key.

import { atom, type PrimitiveAtom } from "jotai";

export const renamingRowAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;
