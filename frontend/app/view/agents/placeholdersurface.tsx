// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { SurfaceEmptyState } from "./surfacescaffold";

const TITLES: Record<string, string> = {
    files: "Files",
    memory: "Memory",
};

export function PlaceholderSurface({ surface }: { surface: string }) {
    return <SurfaceEmptyState title={TITLES[surface] ?? surface} body="Coming soon." />;
}
