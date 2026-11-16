// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ImageZoom, type ZoomImage } from "@/app/element/imagezoom";
import { cn } from "@/util/util";
import { useState } from "react";

// a wrapping row of small thumbnails; each opens the shared ImageZoom on its image, so a step card and a bubble
// show an image without taking its full height

export const THUMB_MAX_HEIGHT_PX = 96;
export const THUMB_MAX_HEIGHT_COMPACT_PX = 64;

export function ImageThumbs({
    images,
    compact,
    onError,
}: {
    images: ZoomImage[];
    compact?: boolean;
    onError?: (index: number) => void;
}) {
    const [zoomed, setZoomed] = useState<ZoomImage | null>(null);
    const maxHeight = compact ? THUMB_MAX_HEIGHT_COMPACT_PX : THUMB_MAX_HEIGHT_PX;
    return (
        <>
            <div data-image-thumbs className="flex flex-wrap gap-2">
                {images.map((img, i) => (
                    <button
                        key={i}
                        type="button"
                        data-image-thumb
                        aria-label={img.alt ? `Open ${img.alt}` : "Open image"}
                        onClick={() => setZoomed(img)}
                        className={cn(
                            "cursor-pointer overflow-hidden rounded-[8px] border border-edge-mid bg-surface-code p-0",
                            "hover:border-accent-soft"
                        )}
                    >
                        <img
                            src={img.src}
                            alt={img.alt ?? ""}
                            style={{ maxHeight }}
                            className="block max-w-full object-contain"
                            onError={onError ? () => onError(i) : undefined}
                        />
                    </button>
                ))}
            </div>
            <ImageZoom image={zoomed} onClose={() => setZoomed(null)} />
        </>
    );
}
