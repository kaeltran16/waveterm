// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atom } from "jotai";

// true while the Final check viewer is mounted. The key dispatcher counts it as an open modal, which silences
// the surface bindings underneath (the Jarvis list's arrows would otherwise win, being registered first), and
// it is the only gate on the viewer's own bindings.
export const finalShotsViewerOpenAtom = atom(false);
