// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// An image file drawn fit to its box, with its size and Copy path under it: the Code surface's image view, and the
// workspace File tab's. Takes the root path rather than a Code project, so the peek card need not import the
// Code surface.

import { resolveRemoteFile } from "@/app/element/markdown-util";
import { viewFade } from "@/app/element/motiontokens";
import { atoms } from "@/app/store/global-atoms";
import { joinRepoPath, splitRepoPath } from "@/util/paths";
import { useAtomValue } from "jotai";
import { motion } from "motion/react";
import { useEffect, useState } from "react";

export function sizeLabel(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function copyPath(root: string | null, rel: string): void {
    if (root != null) {
        void navigator.clipboard?.writeText(joinRepoPath(root, rel));
    }
}

// fetched the way a Markdown image is (wavesrv bytes as a blob url)
export function ImageView({ root, path, size }: { root: string | null; path: string; size: number }) {
    const [src, setSrc] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    const reduce = useAtomValue(atoms.prefersReducedMotionAtom);
    useEffect(() => {
        if (root == null) {
            return;
        }
        const { dir, file } = splitRepoPath(path);
        let url: string | null = null;
        let gone = false;
        setSrc(null);
        setFailed(false);
        void resolveRemoteFile(file, { connName: "local", baseDir: joinRepoPath(root, dir) }).then((u) => {
            url = u;
            if (gone) {
                if (u != null) {
                    URL.revokeObjectURL(u);
                }
            } else if (u == null) {
                setFailed(true);
            } else {
                setSrc(u);
            }
        });
        return () => {
            gone = true;
            if (url != null) {
                URL.revokeObjectURL(url);
            }
        };
    }, [root, path]);
    // the image, or its failure, fades in over the blank it replaces
    const shown = failed ? "failed" : src != null ? "image" : "none";
    return (
        <div data-code-image className="flex h-full flex-col items-center p-4">
            <motion.div
                key={shown}
                data-code-image-state={shown}
                variants={viewFade}
                initial={reduce ? false : "initial"}
                animate="animate"
                className="flex min-h-0 w-full flex-1 items-center justify-center"
            >
                {failed ? (
                    <p className="text-[12px] text-error">Could not load the image.</p>
                ) : src != null ? (
                    <img
                        src={src}
                        alt={path}
                        onError={() => setFailed(true)}
                        className="max-h-full max-w-full object-contain"
                    />
                ) : null}
            </motion.div>
            <div className="flex flex-none items-center gap-2 pt-3 text-[12px] text-muted">
                <span>{sizeLabel(size)}</span>
                <button
                    type="button"
                    onClick={() => copyPath(root, path)}
                    className="cursor-pointer rounded-[6px] px-2 py-0.5 hover:bg-surface-hover hover:text-primary"
                >
                    Copy path
                </button>
            </div>
        </div>
    );
}
