// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// What a surface can say about its data. "loading" is first load only — a refetch keeps what it has on
// screen. See docs/superpowers/specs/2026-09-24-surface-loading-states-design.md.

export type LoadPhase = "loading" | "empty" | "ready" | "error";
