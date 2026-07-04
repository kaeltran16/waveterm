// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Channels message stream reuses the shared no-cascade entrance guard. Kept as a thin re-export
// so channelssurface.tsx's import path is unchanged. See motiontokens.ts for the implementation and
// docs/superpowers/specs/2026-07-04-channels-motion-design.md for the original rationale.
export { computeEntrances, initialEntranceState, type EntranceState } from "@/app/element/motiontokens";
