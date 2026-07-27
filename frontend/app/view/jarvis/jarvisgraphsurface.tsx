// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { JarvisGraph } from "./jarvisgraph";
import { graphBaseAtom, graphErrorAtom, graphLoadedAtom, loadGraph } from "./jarvisgraphstore";

export function JarvisGraphSurface() {
    const base = useAtomValue(graphBaseAtom);
    const loaded = useAtomValue(graphLoadedAtom);
    const error = useAtomValue(graphErrorAtom);

    useEffect(() => {
        if (!loaded) fireAndForget(loadGraph);
    }, [loaded]);

    if (!loaded) {
        return <div className="flex h-full items-center justify-center text-[13px] text-ink-mid">Loading graph…</div>;
    }
    if (error) {
        return (
            <div className="flex h-full items-center justify-center text-[13px] text-ink-mid">
                Couldn’t read the vault.
            </div>
        );
    }
    if (!base || base.nodes.length === 0) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-[6px] text-ink-mid">
                <div className="text-[14px] font-semibold text-foreground">No vault yet</div>
                <div className="text-[12px]">Tasks, decisions, and memory appear here as they’re captured.</div>
            </div>
        );
    }
    return (
        <div className="relative h-full w-full">
            <JarvisGraph />
        </div>
    );
}
