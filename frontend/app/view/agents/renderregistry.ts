// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ComponentType } from "react";
import type { AgentActionEntry } from "./agentsviewmodel";
import { ChartCard } from "./chartcard";

// The one place a renderer is registered. Fenced blocks are keyed by language and consulted by
// MarkdownMessage, so a chart block draws wherever markdown renders. Tool output is keyed by tool
// and consulted by NarrationTimeline only when its `renderers` prop is set.

export type BlockRenderer = ComponentType<{ raw: string }>;

export const BLOCK_RENDERERS: Record<string, BlockRenderer> = { chart: ChartCard };

export function blockRendererFor(lang?: string): BlockRenderer | undefined {
    return lang && Object.prototype.hasOwnProperty.call(BLOCK_RENDERERS, lang) ? BLOCK_RENDERERS[lang] : undefined;
}

export type ToolRendererKey = "image" | "git-diff" | "test";

// stub: Task 5 returns a key for the tools it renders.
export function toolRendererKey(_action: AgentActionEntry): ToolRendererKey | null {
    return null;
}
