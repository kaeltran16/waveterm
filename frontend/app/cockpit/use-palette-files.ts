// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Files scope's data: which project it lists, and that project's index. Code's own index when Code has
// the project open, else one loaded here on first use of the scope.

import type { SurfaceKey } from "@/app/store/keybindings/types";
import { channelProjectLabel } from "@/app/view/agents/projectlabel";
import type { History } from "@/app/view/code/codehistory";
import {
    codeHistoryAtom,
    codeIndexAtom,
    codeProjectAtom,
    loadFileIndex,
    type CodeIndex,
    type CodeProject,
} from "@/app/view/code/codestore";
import { sameRepoPath } from "@/util/paths";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";

export interface PaletteFiles {
    target: CodeProject | null;
    index: CodeIndex | undefined; // undefined while it loads
    error: string | undefined;
    history: History | null; // Code's history, when Code has the target open
}

export function usePaletteFiles(
    open: boolean,
    inFiles: boolean,
    surface: SurfaceKey,
    homeChannel: Channel | null,
    projects: Record<string, ProjectKeywords>
): PaletteFiles {
    const codeProject = useAtomValue(codeProjectAtom);
    const codeIndex = useAtomValue(codeIndexAtom);
    const codeHistory = useAtomValue(codeHistoryAtom);
    const [loaded, setLoaded] = useState<{ path: string; index?: CodeIndex; error?: string } | null>(null);

    useEffect(() => {
        if (open) {
            setLoaded((cur) => (cur?.error != null ? null : cur)); // a failed listing gets another try
        }
    }, [open]);

    // On Code, the project Code has open; elsewhere, the active project — not whatever Code last had.
    const target = useMemo(() => {
        if (surface === "code" && codeProject != null) {
            return codeProject;
        }
        if (homeChannel?.projectpath) {
            return { name: channelProjectLabel(homeChannel, projects), path: homeChannel.projectpath };
        }
        return null;
    }, [surface, codeProject, homeChannel, projects]);
    const codeOwnsTarget = codeProject != null && target != null && sameRepoPath(codeProject.path, target.path);
    const needLoad = open && inFiles && target != null && !(codeOwnsTarget && codeIndex != null);
    useEffect(() => {
        if (!needLoad || loaded?.path === target.path) {
            return;
        }
        const path = target.path;
        setLoaded({ path });
        loadFileIndex(path).then(
            (index) => setLoaded((cur) => (cur?.path === path ? { path, index } : cur)),
            (e) => setLoaded((cur) => (cur?.path === path ? { path, error: String(e) } : cur))
        );
    }, [needLoad, target?.path]);

    const index =
        codeOwnsTarget && codeIndex != null
            ? codeIndex
            : loaded != null && loaded.path === target?.path
              ? loaded.index
              : undefined;
    return {
        target,
        index,
        error: loaded?.path === target?.path ? loaded?.error : undefined,
        history: codeOwnsTarget ? codeHistory : null,
    };
}
