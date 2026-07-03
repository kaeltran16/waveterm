// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Line-art glyphs for the collapsible rail section strips (Agent details + Channels). Same visual
// language as the NavRail ICON set (20x20, currentColor, ~1.6 stroke, round joins) so the edge icon
// strips read as one system instead of FontAwesome solid glyphs sitting next to the nav's line art.

import type { ReactNode } from "react";

const svg = (children: ReactNode) => (
    <svg
        width="20"
        height="20"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
    >
        {children}
    </svg>
);

export const RAIL_ICON: Record<string, ReactNode> = {
    // circle with an "i" — details/overview
    info: svg(
        <>
            <circle cx="10" cy="10" r="7.2" />
            <path d="M10 9.2v4" />
            <circle cx="10" cy="6.4" r="0.5" fill="currentColor" stroke="none" />
        </>
    ),
    // ascending bars — context window / usage chart
    context: svg(
        <>
            <path d="M4.5 14v2" />
            <path d="M10 9v7" />
            <path d="M15.5 4.5v11.5" />
        </>
    ),
    // parent node branching to two children — subagents
    subagents: svg(
        <>
            <circle cx="10" cy="4.6" r="1.9" />
            <circle cx="5" cy="15.4" r="1.9" />
            <circle cx="15" cy="15.4" r="1.9" />
            <path d="M10 6.5v4M5 11.5v2M15 11.5v2M5 11.5h10" />
        </>
    ),
    // wrench — tools
    tools: svg(
        <path d="M14.2 3.4a3.4 3.4 0 0 0-4.4 4.2l-5.3 5.3a1.5 1.5 0 0 0 2.1 2.1l5.3-5.3a3.4 3.4 0 0 0 4.2-4.4l-2.1 2.1-1.8-.3-.3-1.8z" />
    ),
    // document with a folded corner + text lines — files touched
    files: svg(
        <>
            <path d="M5.5 3.5h5.5L15 7.5v9H5.5z" />
            <path d="M11 3.5V7.5h4" />
            <path d="M8 11h4M8 13.5h4" />
        </>
    ),
    // rhombus — autonomy (jarvis)
    autonomy: svg(<path d="M10 3l7 7-7 7-7-7z" />),
    // two people — fleet
    fleet: svg(
        <>
            <circle cx="7.4" cy="7.2" r="2.5" />
            <path d="M3.2 16c0-2.4 1.9-4 4.2-4s4.2 1.6 4.2 4" />
            <path d="M13.4 5.2a2.5 2.5 0 0 1 0 4.9" />
            <path d="M13.2 12.1c1.9.3 3.6 1.7 3.6 3.9" />
        </>
    ),
    // bell — needs you
    bell: svg(
        <>
            <path d="M6 8.6a4 4 0 0 1 8 0c0 3.4 1.1 4.6 1.1 4.6H4.9S6 12 6 8.6z" />
            <path d="M8.7 15.6a1.7 1.7 0 0 0 2.6 0" />
        </>
    ),
    // folder — project
    folder: svg(<path d="M3.6 15.5v-9h3.9l1.6 2h7.3v7z" />),
};
