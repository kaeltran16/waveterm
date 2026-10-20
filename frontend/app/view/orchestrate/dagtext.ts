// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The DAG modal's type scale (dag-inspector Type.dc.html): titles 13px, prose 12.5px sans, meta, times and ids
// 11.5px mono in ink-mid. text-muted is for decoration only, never for text meant to be read.

export const DAG_META = "font-mono text-[11.5px] text-ink-mid";

// a popup's label/value rows: a sans label beside a mono value with an optional ink-mid sub line
export const PEEK_DL = "m-0 grid grid-cols-[62px_minmax(0,1fr)] gap-x-2.5 gap-y-[9px]";
export const PEEK_DT = "text-[12.5px] leading-[18px] text-ink-mid";
export const PEEK_DD = "m-0 min-w-0 font-mono text-[12.5px] leading-[18px]";
export const PEEK_DD_SUB = "truncate text-[11.5px] leading-[17px] text-ink-mid";
