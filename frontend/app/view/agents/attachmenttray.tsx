// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Presentational pieces for the New run goal's attachments: the chip tray (image thumbnails / file icons with
// per-chip remove + retry) and the plus that opens the native file dialog. State + behavior live in
// useComposerAttachments (composerattachments.ts); these are pure props-in views.

import { File as FileIcon, Loader2, Plus, X } from "lucide-react";
import { isOversize, type Attachment } from "./composerattachments";

function fmtSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${Math.round(bytes / 1024)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Chip({
    att,
    onRemove,
    onRetry,
}: {
    att: Attachment;
    onRemove: (id: string) => void;
    onRetry: (id: string) => void;
}) {
    const isError = att.status === "error";
    const isUploading = att.status === "uploading";
    const oversize = isOversize(att.size ?? 0);
    // an oversize file was never kept, so there is nothing to retry
    const canRetry = isError && !oversize;
    const shell =
        "flex h-[30px] items-center gap-1.5 rounded-[7px] border bg-surface px-2 text-[12px] text-secondary" +
        (isError ? " border-error/40" : " border-edge-mid") +
        (att.kind === "image" && att.previewUrl ? " pl-[3px]" : "") +
        (isUploading ? " opacity-70" : "");
    return (
        <span
            data-attachment-chip={att.status}
            data-attachment-path={att.path}
            title={att.error ?? att.path ?? att.name}
            className={shell}
        >
            {att.kind === "image" && att.previewUrl ? (
                <img src={att.previewUrl} alt="" className="h-6 w-6 rounded-[4px] bg-surface-selected object-cover" />
            ) : (
                <FileIcon size={13} className="shrink-0 text-muted" />
            )}
            <span className="max-w-[160px] truncate font-mono">{att.name}</span>
            {isError ? (
                <span className="shrink-0 text-error">{oversize ? "too large" : "upload failed"}</span>
            ) : att.kind !== "image" && att.size != null ? (
                <span className="shrink-0 text-muted">{fmtSize(att.size)}</span>
            ) : null}
            {isUploading ? (
                <Loader2 size={12} className="shrink-0 animate-spin motion-reduce:animate-none text-muted" />
            ) : null}
            {canRetry ? (
                <button
                    type="button"
                    title="Retry"
                    onClick={() => onRetry(att.id)}
                    className="shrink-0 cursor-pointer text-[12px] text-error hover:opacity-80"
                >
                    Retry
                </button>
            ) : null}
            <button
                type="button"
                title="Remove"
                aria-label={`Remove ${att.name}`}
                onClick={() => onRemove(att.id)}
                className="inline-flex shrink-0 cursor-pointer text-muted hover:text-error"
            >
                <X size={12} strokeWidth={2.4} />
            </button>
        </span>
    );
}

export function AttachmentTray({
    items,
    onRemove,
    onRetry,
}: {
    items: Attachment[];
    onRemove: (id: string) => void;
    onRetry: (id: string) => void;
}) {
    if (items.length === 0) {
        return null;
    }
    return (
        <div className="flex min-w-0 flex-wrap gap-1.5">
            {items.map((a) => (
                <Chip key={a.id} att={a} onRemove={onRemove} onRetry={onRetry} />
            ))}
        </div>
    );
}

export function AttachButton({ onClick }: { onClick: () => void }) {
    return (
        <button
            type="button"
            title="Attach files"
            aria-label="Attach files"
            data-attach-files
            onClick={onClick}
            className="inline-flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-[7px] text-ink-mid hover:bg-surface-hover hover:text-secondary"
        >
            <Plus size={16} strokeWidth={2} />
        </button>
    );
}
