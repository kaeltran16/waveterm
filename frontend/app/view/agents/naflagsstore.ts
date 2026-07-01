// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// New Agent launch-flag state, lifted out of NewAgentModal so a "remembered" set survives the modal
// unmounting on close (the modal returns null while shut, which would reset component useState).

import { atom } from "jotai";

// Enabled flags keyed by flag id (shared across runtimes; the modal filters by the selected runtime's
// catalog). Defaults to none enabled.
export const naFlagsAtom = atom<Record<string, boolean>>({});

// When on, the enabled flags carry over to the next New Agent open; when off, they clear after launch.
export const naRememberFlagsAtom = atom<boolean>(true);
