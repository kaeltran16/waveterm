// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Real brand marks for the coding-agent runtimes, so a channel author avatar shows the tool's actual
// logo instead of an ambiguous colored initial (claude and codex both start with "C"). The main app has
// no svgr, so .svg imports are URLs (Vite assets); render as <img src>. Unknown authors: undefined.

import AntigravityLogo from "@/app/asset/antigravity.svg";
import ClaudeLogo from "@/app/asset/claude-color.svg";
import CodexLogo from "@/app/asset/codex.svg";

const RUNTIME_LOGO: Record<string, string> = {
    claude: ClaudeLogo,
    codex: CodexLogo,
    antigravity: AntigravityLogo,
};

// The brand mark URL for a runtime author name (case-insensitive), or undefined for humans/jarvis/roster.
export function runtimeLogo(name: string): string | undefined {
    return RUNTIME_LOGO[name.toLowerCase()];
}
