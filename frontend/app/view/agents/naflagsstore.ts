// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// New Agent launch-flag state, lifted out of NewAgentModal so a "remembered" set survives the modal
// unmounting on close (the modal returns null while shut, which would reset component useState).

import { atom } from "jotai";

import type { Runtime } from "./launch";

// Enabled flags scoped per runtime, then keyed by flag id. Scoping by runtime keeps each TUI's flag
// set independent: some ids are shared across catalogs (e.g. "skip-permissions" maps to a different
// CLI token per runtime), so a flat id->bool map would bleed a Claude choice into Codex. Defaults to
// none enabled.
export const naFlagsAtom = atom<Partial<Record<Runtime, Record<string, boolean>>>>({});

// When on, the enabled flags carry over to the next New Agent open; when off, they clear after launch.
export const naRememberFlagsAtom = atom<boolean>(true);
