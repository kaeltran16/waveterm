// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The one place a scribe skeleton becomes Excalidraw elements. Its own module so the applier and its tests do
// not load the Excalidraw runtime.

import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

// new ids on every conversion, so a redraw never collides with the group it replaces (decision 11)
export function convertSkeleton(skeleton: string): ExcalidrawElement[] {
    const parsed: unknown = JSON.parse(skeleton);
    if (!Array.isArray(parsed)) {
        throw new Error("the skeleton is not a list of elements");
    }
    return convertToExcalidrawElements(parsed as ExcalidrawElementSkeleton[], { regenerateIds: true });
}
