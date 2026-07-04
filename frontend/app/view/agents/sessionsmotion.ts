// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Sessions' filter reflow reuses the shared reflowProps primitive. Kept as a thin re-export so
// sessionssurface.tsx's import path is unchanged. See motiontokens.ts for the implementation and
// docs/superpowers/specs/2026-07-03-sessions-motion-design.md for the original rationale.
export { reflowProps, type ReflowProps } from "@/app/element/motiontokens";
