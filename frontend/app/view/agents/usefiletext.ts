// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Reads a document for inline review (PlanPreview, DocReviewDialog). A missing, unreadable or empty file
// reads as "error", so the caller shows a line in its place and never blocks its own actions on it.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { base64ToString, fireAndForget } from "@/util/util";
import { useEffect, useState } from "react";

export interface FileText {
    status: "loading" | "error" | "ok";
    text: string;
    lines: number;
}

export const fileTextOf = (text: string): FileText => ({ status: "ok", text, lines: text.split("\n").length });

const LOADING: FileText = { status: "loading", text: "", lines: 0 };
const ERROR: FileText = { status: "error", text: "", lines: 0 };

// setLoad lets a caller that writes the file (PlanPreview's editor) show what it saved without a re-read
export function useFileText(path: string): [FileText, (next: FileText) => void] {
    const [load, setLoad] = useState<FileText>(LOADING);
    useEffect(() => {
        let alive = true;
        setLoad(LOADING);
        fireAndForget(async () => {
            try {
                const fileData = await RpcApi.FileReadCommand(TabRpcClient, { info: { path } });
                const text = fileData?.data64 ? base64ToString(fileData.data64) : "";
                if (alive) {
                    setLoad(text.trim() ? fileTextOf(text) : ERROR);
                }
            } catch {
                if (alive) {
                    setLoad(ERROR);
                }
            }
        });
        return () => {
            alive = false;
        };
    }, [path]);
    return [load, setLoad];
}
