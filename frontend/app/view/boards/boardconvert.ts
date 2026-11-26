// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The one place a skeleton becomes Excalidraw elements and changed text is measured. Its own module so the
// applier and its tests do not load the Excalidraw runtime.

import { convertToExcalidrawElements, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { layoutAnswer, type BoardGraph, type MeasureLabel } from "./boardlayout";
import { applyAnswer, type AnswerResult, type BoardScene } from "./boardmodel";

function parseSkeleton(skeleton: string): ExcalidrawElementSkeleton[] {
    const parsed: unknown = JSON.parse(skeleton);
    if (!Array.isArray(parsed)) {
        throw new Error("the skeleton is not a list of elements");
    }
    return parsed as ExcalidrawElementSkeleton[];
}

// new ids on every conversion, so a redraw never collides with the group it replaces (decision 11)
function convert(skeletons: ExcalidrawElementSkeleton[]): ExcalidrawElement[] {
    return convertToExcalidrawElements(skeletons, { regenerateIds: true });
}

export function convertSkeleton(skeleton: string): ExcalidrawElement[] {
    return convert(parseSkeleton(skeleton));
}

// a label as Excalidraw lays out a new text: its default font and size, newlines kept
const measureLabel: MeasureLabel = (text) => {
    const [el] = convertToExcalidrawElements([{ type: "text", text, x: 0, y: 0 }]);
    return { width: el.width, height: el.height };
};

// Go checks the graph's shape but not its style keys, so a style that is not a string is dropped
function parseGraph(graph: string | undefined): BoardGraph | null {
    if (!graph) {
        return null;
    }
    const parsed = JSON.parse(graph) as BoardGraph;
    const color = (v: unknown) => (typeof v === "string" ? v : undefined);
    return {
        ...parsed,
        nodes: parsed.nodes.map((n) => ({
            ...n,
            strokeColor: color(n.strokeColor),
            backgroundColor: color(n.backgroundColor),
        })),
        edges: parsed.edges?.map((e) => ({ ...e, strokeColor: color(e.strokeColor), dashed: e.dashed === true })),
    };
}

// a box's label sits in its middle, as Excalidraw lays it out; an arrow's stays where it was measured
function centered(text: ExcalidrawElement, container: ExcalidrawElement | undefined): Partial<ExcalidrawElement> {
    if (container == null || "points" in container) {
        return {};
    }
    return {
        x: container.x + (container.width - text.width) / 2,
        y: container.y + (container.height - text.height) / 2,
    };
}

// re-wraps and re-measures the answer's changed text against its container, through Excalidraw's own restore;
// only the text's words and box are taken from it, so versions and everything else stay as applyAnswer set them.
function measure(elements: readonly ExcalidrawElement[], textIds: readonly string[]): ExcalidrawElement[] {
    if (textIds.length === 0) {
        return [...elements];
    }
    const restored = new Map(
        restoreElements(elements, null, { refreshDimensions: true, repairBindings: true }).map((el) => [el.id, el])
    );
    const byId = new Map(elements.map((el) => [el.id, el]));
    const wanted = new Set(textIds);
    return elements.map((el) => {
        const r = restored.get(el.id);
        if (!wanted.has(el.id) || r == null || r.type !== "text") {
            return el;
        }
        const sized = { ...el, text: r.text, x: r.x, y: r.y, width: r.width, height: r.height } as ExcalidrawElement;
        return { ...sized, ...centered(sized, byId.get(r.containerId ?? "")) } as ExcalidrawElement;
    });
}

export function landAnswer(scene: BoardScene, answer: BoardAnswer, now: number): AnswerResult {
    const add = answer.add ? parseSkeleton(answer.add) : [];
    const skeletons = layoutAnswer(parseGraph(answer.graph), add, measureLabel);
    const added = skeletons.length > 0 ? convert(skeletons) : [];
    return applyAnswer(scene, answer, added, now, measure);
}
