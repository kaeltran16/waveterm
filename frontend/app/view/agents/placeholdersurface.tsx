// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

const TITLES: Record<string, string> = {
    channels: "Channels",
    sessions: "Sessions",
    files: "Files",
    memory: "Memory",
};

export function PlaceholderSurface({ surface }: { surface: string }) {
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-center">
            <div className="text-[15px] font-semibold text-secondary">{TITLES[surface] ?? surface}</div>
            <div className="text-[12px] text-muted">Coming soon.</div>
        </div>
    );
}
