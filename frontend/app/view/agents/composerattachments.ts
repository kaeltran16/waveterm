// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Channels composer attachments: capture (paste / paperclip / drag-drop) -> persist to a wavesrv temp
// file via WriteTempFileCommand -> reference-by-path in the sent text. Pure helpers below are unit-tested
// (composerattachments.test.ts); the useComposerAttachments hook (impure: RPC + FileReader + object URLs)
// is verified over CDP against the live dev app, per CLAUDE.md's testing convention.

import base64 from "base64-js";
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB; base64 inflates ~33%, bounding the RPC payload

export type AttachmentKind = "image" | "file";
export type AttachmentStatus = "uploading" | "ready" | "error";

export interface Attachment {
    id: string;
    name: string;
    kind: AttachmentKind;
    status: AttachmentStatus;
    size: number;
    path?: string; // absolute temp path once uploaded
    previewUrl?: string; // object URL for image thumbnails
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic", "heif"]);

// image when the mime says so, else fall back to the extension (dragged/pasted files often have empty type).
export function classifyKind(file: { name: string; type: string }): AttachmentKind {
    if (file.type.startsWith("image/")) {
        return "image";
    }
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    return IMAGE_EXTS.has(ext) ? "image" : "file";
}

// at the cap is allowed; strictly over is rejected before any RPC.
export function isOversize(size: number): boolean {
    return size > MAX_ATTACHMENT_BYTES;
}

// Appends a trailing "read these files" block listing every ready attachment's absolute path. Returns
// `text` unchanged when nothing is ready; when the base text is blank, returns just the block.
export function appendAttachments(text: string, atts: Attachment[]): string {
    const ready = atts.filter((a) => a.status === "ready" && a.path);
    if (ready.length === 0) {
        return text;
    }
    const block = "Attachments (read these files):\n" + ready.map((a) => `- ${a.path}`).join("\n");
    return text.trim() ? `${text}\n\n${block}` : block;
}

export interface UseComposerAttachments {
    attachments: Attachment[];
    add: (files: FileList | File[]) => void;
    remove: (id: string) => void;
    retry: (id: string) => void;
    clear: () => void;
    uploading: boolean;
    readyCount: number;
    isDragging: boolean;
    dnd: {
        onPaste: (e: ClipboardEvent) => void;
        onDragOver: (e: DragEvent) => void;
        onDragLeave: (e: DragEvent) => void;
        onDrop: (e: DragEvent) => void;
    };
}

// Owns attachment state + the three capture sources. Lives in channelssurface (both faces share `draft`
// and the single send handler), passed down to the presentational composers.
export function useComposerAttachments(): UseComposerAttachments {
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const [isDragging, setIsDragging] = useState(false);
    const filesRef = useRef<Map<string, File>>(new Map()); // retained for retry(); not part of the serializable chip
    const previewsRef = useRef<Set<string>>(new Set()); // outstanding object URLs to revoke

    const update = useCallback((id: string, patch: Partial<Attachment>) => {
        setAttachments((cur) => cur.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    }, []);

    const persist = useCallback(
        async (id: string, file: File) => {
            try {
                const buf = await file.arrayBuffer();
                const data64 = base64.fromByteArray(new Uint8Array(buf));
                const path = await RpcApi.WriteTempFileCommand(TabRpcClient, { filename: file.name, data64 });
                update(id, { status: "ready", path });
            } catch {
                update(id, { status: "error" });
            }
        },
        [update]
    );

    const add = useCallback(
        (files: FileList | File[]) => {
            for (const file of Array.from(files)) {
                const id = crypto.randomUUID();
                const kind = classifyKind(file);
                if (isOversize(file.size)) {
                    setAttachments((cur) => [...cur, { id, name: file.name, kind, status: "error", size: file.size }]);
                    continue; // rejected before any RPC
                }
                const previewUrl = kind === "image" ? URL.createObjectURL(file) : undefined;
                if (previewUrl) {
                    previewsRef.current.add(previewUrl);
                }
                filesRef.current.set(id, file);
                setAttachments((cur) => [
                    ...cur,
                    { id, name: file.name, kind, status: "uploading", size: file.size, previewUrl },
                ]);
                fireAndForget(() => persist(id, file));
            }
        },
        [persist]
    );

    const remove = useCallback((id: string) => {
        setAttachments((cur) => {
            const target = cur.find((a) => a.id === id);
            if (target?.previewUrl) {
                URL.revokeObjectURL(target.previewUrl);
                previewsRef.current.delete(target.previewUrl);
            }
            return cur.filter((a) => a.id !== id);
        });
        filesRef.current.delete(id);
    }, []);

    const retry = useCallback(
        (id: string) => {
            const file = filesRef.current.get(id);
            if (!file) {
                return;
            }
            update(id, { status: "uploading" });
            fireAndForget(() => persist(id, file));
        },
        [persist, update]
    );

    const clear = useCallback(() => {
        for (const url of previewsRef.current) {
            URL.revokeObjectURL(url);
        }
        previewsRef.current.clear();
        filesRef.current.clear();
        setAttachments([]);
    }, []);

    // revoke any outstanding object URLs on unmount
    useEffect(
        () => () => {
            for (const url of previewsRef.current) {
                URL.revokeObjectURL(url);
            }
            previewsRef.current.clear();
        },
        []
    );

    const dnd = {
        // only intercept when the clipboard carries files; plain text paste is left untouched.
        onPaste: (e: ClipboardEvent) => {
            const files = filesFromClipboard(e);
            if (files.length > 0) {
                e.preventDefault();
                add(files);
            }
        },
        onDragOver: (e: DragEvent) => {
            e.preventDefault();
            setIsDragging(true);
        },
        // ignore dragleave onto a descendant (prevents overlay flicker while dragging over the tray/input)
        onDragLeave: (e: DragEvent) => {
            if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) {
                setIsDragging(false);
            }
        },
        onDrop: (e: DragEvent) => {
            e.preventDefault();
            setIsDragging(false);
            if (e.dataTransfer.files.length > 0) {
                add(e.dataTransfer.files);
            }
        },
    };

    return {
        attachments,
        add,
        remove,
        retry,
        clear,
        uploading: attachments.some((a) => a.status === "uploading"),
        readyCount: attachments.filter((a) => a.status === "ready").length,
        isDragging,
        dnd,
    };
}

function filesFromClipboard(e: ClipboardEvent): File[] {
    const cd = e.clipboardData;
    if (!cd) {
        return [];
    }
    if (cd.files && cd.files.length > 0) {
        return Array.from(cd.files);
    }
    // fallback: some sources expose files only via items
    return Array.from(cd.items ?? [])
        .filter((i) => i.kind === "file")
        .map((i) => i.getAsFile())
        .filter((f): f is File => f != null);
}
