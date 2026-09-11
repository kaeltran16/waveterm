// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The subject vocabulary: what the surface can be pointed at. This module used to carry the Subjects
// column's whole model — marks, filters, the "which channel does this goal belong to" search, the group
// builders — and all of that died with the column. What survives is the one list of kinds, which is what
// every remaining consumer actually imports.
//
// "effort-list" was dropped here rather than kept for symmetry: its only renderer was the Stage's
// EffortsListView, the Brief's Initiatives region is not a subject, and a kind nothing can select is a
// kind that would silently render as nothing.

export type SubjectKind = "channel" | "dossier" | "conversation" | "briefing" | "effort";
