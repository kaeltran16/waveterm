// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The board's scene logic: parse/serialize the file, place a scribe draw (new group, in-place replace, or a
// pending frame beside an edited group), Keep/Drop, and the rows and facts the Boards surface shows. Pure: no
// React, no RPC, no Excalidraw runtime.

import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

export const ARC_SOURCE = "arcSource"; // customData key on scribe elements

const FIRST_DRAW_GAP = 120; // a first draw sits this far right of the board's content
const PENDING_GAP = 80; // a pending frame sits this far right of the edited group
const FRAME_PAD = 10; // Excalidraw's own padding when it fits a frame to its children
const PENDING_OPACITY = 40;
const FULL_OPACITY = 100;
const READ_WHOLE_KINDS = new Set(["run", "effort", "record"]);

export interface BoardScene {
    arc: BoardArcRecord;
    elements: readonly ExcalidrawElement[];
    appState: Record<string, unknown>;
    files: Record<string, unknown>;
}

export class BoardFileError extends Error {}

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v != null && !Array.isArray(v);
}

export function parseBoardFile(text: string): BoardScene {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        throw new BoardFileError(`not valid JSON: ${(e as Error).message}`);
    }
    if (!isObject(raw)) {
        throw new BoardFileError("not a board file: the top level is not an object");
    }
    const arc = raw.arc;
    if (!isObject(arc) || typeof arc.name !== "string") {
        throw new BoardFileError("not a board file: no arc record with a name");
    }
    if (raw.elements != null && !Array.isArray(raw.elements)) {
        throw new BoardFileError("elements is not a list");
    }
    if (arc.sources != null && !Array.isArray(arc.sources)) {
        throw new BoardFileError("arc sources is not a list");
    }
    return {
        arc: arc as unknown as BoardArcRecord,
        elements: (raw.elements ?? []) as ExcalidrawElement[],
        appState: isObject(raw.appState) ? raw.appState : {},
        files: isObject(raw.files) ? raw.files : {},
    };
}

// "arc" goes first so a file damaged at its end still names itself (decision 6). Deleted elements are dropped,
// as Excalidraw's own export does.
export function serializeBoard(scene: BoardScene): string {
    const file = {
        arc: scene.arc,
        type: "excalidraw",
        version: 2,
        source: "arc",
        elements: live(scene.elements),
        appState: scene.appState,
        files: scene.files,
    };
    return JSON.stringify(file, null, 2);
}

function live(elements: readonly ExcalidrawElement[]): ExcalidrawElement[] {
    return elements.filter((el) => !el.isDeleted);
}

function inGroup(el: ExcalidrawElement, groupId: string): boolean {
    return !el.isDeleted && el.groupIds.includes(groupId);
}

function sourceOf(el: ExcalidrawElement): string | undefined {
    return el.customData?.[ARC_SOURCE];
}

// cyrb53: a fast 53-bit string hash; this only needs to notice change, not resist attack.
function hash53(str: string): string {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

// originalText, not text: resizing a container rewraps text, and resizing is not an edit (decision 9).
function elementText(el: ExcalidrawElement): string {
    if (el.type !== "text") {
        return "";
    }
    return el.originalText ?? el.text ?? "";
}

export function contentHash(elements: readonly ExcalidrawElement[], groupId: string): string {
    const triples = elements
        .filter((el) => inGroup(el, groupId))
        .map((el) => JSON.stringify([el.id, el.type, elementText(el)]))
        .sort();
    return hash53(triples.join("\n"));
}

function isEdited(src: BoardArcSource, elements: readonly ExcalidrawElement[]): boolean {
    return !!src.editedts || contentHash(elements, src.groupid) !== src.contenthash;
}

export function markEdits(scene: BoardScene, now: number): BoardScene {
    let changed = false;
    const sources = (scene.arc.sources ?? []).map((src) => {
        if (src.editedts || contentHash(scene.elements, src.groupid) === src.contenthash) {
            return src;
        }
        changed = true;
        return { ...src, editedts: now };
    });
    return changed ? { ...scene, arc: { ...scene.arc, sources } } : scene;
}

// --- geometry

interface Bounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

function elementBounds(el: ExcalidrawElement): Bounds {
    if ("points" in el && el.points.length > 0) {
        const xs = el.points.map((p) => p[0]);
        const ys = el.points.map((p) => p[1]);
        return {
            minX: el.x + Math.min(...xs),
            minY: el.y + Math.min(...ys),
            maxX: el.x + Math.max(...xs),
            maxY: el.y + Math.max(...ys),
        };
    }
    return { minX: el.x, minY: el.y, maxX: el.x + el.width, maxY: el.y + el.height };
}

function boundsOf(elements: readonly ExcalidrawElement[]): Bounds | null {
    if (elements.length === 0) {
        return null;
    }
    const all = elements.map(elementBounds);
    return {
        minX: Math.min(...all.map((b) => b.minX)),
        minY: Math.min(...all.map((b) => b.minY)),
        maxX: Math.max(...all.map((b) => b.maxX)),
        maxY: Math.max(...all.map((b) => b.maxY)),
    };
}

function patch(el: ExcalidrawElement, props: Record<string, unknown>): ExcalidrawElement {
    return { ...el, ...props } as ExcalidrawElement;
}

// moves the elements so their bbox's top-left lands on (x, y), scaled by s about that corner.
function placeAt(elements: readonly ExcalidrawElement[], x: number, y: number, s: number): ExcalidrawElement[] {
    const b = boundsOf(elements);
    if (b == null) {
        return [];
    }
    return elements.map((el) => {
        const props: Record<string, unknown> = {
            x: x + (el.x - b.minX) * s,
            y: y + (el.y - b.minY) * s,
            width: el.width * s,
            height: el.height * s,
        };
        if ("points" in el) {
            props.points = el.points.map((p) => [p[0] * s, p[1] * s]);
        }
        if (el.type === "text") {
            props.fontSize = el.fontSize * s;
        }
        return patch(el, props);
    });
}

// where a first draw goes: right of everything on the board, top-aligned; the origin on an empty board.
function firstDrawSpot(elements: readonly ExcalidrawElement[]): { x: number; y: number } {
    const b = boundsOf(live(elements));
    return b == null ? { x: 0, y: 0 } : { x: b.maxX + FIRST_DRAW_GAP, y: b.minY };
}

// --- applying a draw

export type ApplyOutcome = "new" | "replaced" | "pending";

function groupIdFor(drawId: string): string {
    return `arc-group-${drawId}`;
}

function frameIdFor(drawId: string): string {
    return `arc-frame-${drawId}`;
}

function tag(elements: readonly ExcalidrawElement[], key: string, groupId: string): ExcalidrawElement[] {
    return elements.map((el) =>
        patch(el, { customData: { ...el.customData, [ARC_SOURCE]: key }, groupIds: [...el.groupIds, groupId] })
    );
}

function naturalBox(elements: readonly ExcalidrawElement[], x: number, y: number): BoardBox {
    const b = boundsOf(elements);
    return b == null ? { x, y, w: 0, h: 0 } : { x, y, w: b.maxX - b.minX, h: b.maxY - b.minY };
}

function withSource(scene: BoardScene, src: BoardArcSource): BoardScene {
    const sources = scene.arc.sources ?? [];
    const has = sources.some((s) => s.key === src.key);
    const next = has ? sources.map((s) => (s.key === src.key ? src : s)) : [...sources, src];
    return { ...scene, arc: { ...scene.arc, sources: next } };
}

// the fields every Excalidraw element carries; the seed is derived from the id, so a test sees the same element.
function newElement(id: string, now: number, props: Record<string, unknown>): ExcalidrawElement {
    const seed = parseInt(hash53(id).slice(-8), 16);
    return {
        id,
        strokeColor: "#1e1e1e",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 2,
        strokeStyle: "solid",
        roundness: null,
        roughness: 1,
        opacity: FULL_OPACITY,
        angle: 0,
        seed,
        version: 1,
        versionNonce: seed,
        index: null,
        isDeleted: false,
        groupIds: [],
        frameId: null,
        boundElements: null,
        updated: now,
        link: null,
        locked: false,
        ...props,
    } as unknown as ExcalidrawElement;
}

function newFrame(id: string, name: string, key: string, b: Bounds, now: number): ExcalidrawElement {
    return newElement(id, now, {
        type: "frame",
        name,
        x: b.minX - FRAME_PAD,
        y: b.minY - FRAME_PAD,
        width: b.maxX - b.minX + 2 * FRAME_PAD,
        height: b.maxY - b.minY + 2 * FRAME_PAD,
        // excalidraw's own frame style
        strokeColor: "#bbb",
        roughness: 0,
        customData: { [ARC_SOURCE]: key },
    });
}

function isPendingPart(el: ExcalidrawElement, key: string, pending: BoardArcPending): boolean {
    if (sourceOf(el) !== key) {
        return false;
    }
    return (
        el.id === pending.frameid || el.frameId === pending.frameid || el.groupIds.includes(groupIdFor(pending.drawid))
    );
}

export function applyDraw(
    scene: BoardScene,
    draw: BoardDraw,
    converted: readonly ExcalidrawElement[],
    now: number
): { scene: BoardScene; outcome: ApplyOutcome } {
    const key = draw.sourcekey;
    const src = (scene.arc.sources ?? []).find((s) => s.key === key);
    if (src == null) {
        return { scene: applyNew(scene, draw, converted, now), outcome: "new" };
    }
    if (isEdited(src, scene.elements)) {
        return { scene: applyPending(scene, src, draw, converted, now), outcome: "pending" };
    }
    return { scene: applyReplace(scene, src, draw, converted, now), outcome: "replaced" };
}

function applyNew(
    scene: BoardScene,
    draw: BoardDraw,
    converted: readonly ExcalidrawElement[],
    now: number
): BoardScene {
    const groupId = groupIdFor(draw.id);
    const spot = firstDrawSpot(scene.elements);
    const placed = tag(placeAt(converted, spot.x, spot.y, 1), draw.sourcekey, groupId);
    const elements = [...scene.elements, ...placed];
    return withSource(
        { ...scene, elements },
        {
            key: draw.sourcekey,
            source: draw.source,
            ask: draw.ask,
            groupid: groupId,
            drawnts: now,
            shapes: draw.shapes,
            contenthash: contentHash(elements, groupId),
            box: naturalBox(converted, spot.x, spot.y),
            skeleton: draw.skeleton,
            cursorts: draw.cursorts,
        }
    );
}

// keeps the group's current top-left and its scale: current width over the width as drawn (box.w is unscaled,
// so a group the user resized 2x stays 2x through every redraw).
function applyReplace(
    scene: BoardScene,
    src: BoardArcSource,
    draw: BoardDraw,
    converted: readonly ExcalidrawElement[],
    now: number
): BoardScene {
    const old = scene.elements.filter((el) => inGroup(el, src.groupid));
    const cur = boundsOf(old);
    const spot = cur == null ? firstDrawSpot(scene.elements) : { x: cur.minX, y: cur.minY };
    const scale = cur != null && src.box != null && src.box.w > 0 ? (cur.maxX - cur.minX) / src.box.w : 1;
    const placed = tag(placeAt(converted, spot.x, spot.y, scale), src.key, src.groupid);
    const at = scene.elements.findIndex((el) => inGroup(el, src.groupid));
    const rest = scene.elements.filter((el) => !inGroup(el, src.groupid));
    const insertAt = at < 0 ? rest.length : at;
    const elements = [...rest.slice(0, insertAt), ...placed, ...rest.slice(insertAt)];
    return withSource(
        { ...scene, elements },
        {
            ...src,
            source: draw.source,
            ask: draw.ask,
            drawnts: now,
            shapes: draw.shapes,
            contenthash: contentHash(elements, src.groupid),
            editedts: undefined,
            box: naturalBox(converted, spot.x, spot.y),
            skeleton: draw.skeleton,
            cursorts: draw.cursorts,
        }
    );
}

function overlaps(a: Bounds, b: Bounds): boolean {
    return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

// where a new pending frame's elements go: 80px right of the edited group, top-aligned, when the framed box
// there overlaps nothing; else right of the board's content, the one spot sure to be clear, still top-aligned.
function pendingSpot(
    rest: readonly ExcalidrawElement[],
    group: Bounds,
    converted: readonly ExcalidrawElement[]
): { x: number; y: number } {
    const y = group.minY + FRAME_PAD;
    const beside = { x: group.maxX + PENDING_GAP + FRAME_PAD, y };
    const size = boundsOf(converted) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    const box = {
        minX: beside.x - FRAME_PAD,
        minY: y - FRAME_PAD,
        maxX: beside.x + size.maxX - size.minX + FRAME_PAD,
        maxY: y + size.maxY - size.minY + FRAME_PAD,
    };
    if (!live(rest).some((el) => overlaps(box, elementBounds(el)))) {
        return beside;
    }
    return { x: firstDrawSpot(rest).x + FRAME_PAD, y };
}

// lands the redraw as a faded frame beside the edited group (pendingSpot); a later redraw replaces the frame's
// contents where the frame now is.
function applyPending(
    scene: BoardScene,
    src: BoardArcSource,
    draw: BoardDraw,
    converted: readonly ExcalidrawElement[],
    now: number
): BoardScene {
    const prev = src.pending;
    const oldFrame = prev == null ? undefined : scene.elements.find((el) => !el.isDeleted && el.id === prev.frameid);
    const rest = prev == null ? scene.elements : scene.elements.filter((el) => !isPendingPart(el, src.key, prev));
    let spot: { x: number; y: number };
    if (oldFrame != null) {
        spot = { x: oldFrame.x + FRAME_PAD, y: oldFrame.y + FRAME_PAD };
    } else {
        const group = boundsOf(rest.filter((el) => inGroup(el, src.groupid)));
        spot = group == null ? firstDrawSpot(rest) : pendingSpot(rest, group, converted);
    }
    const frameId = prev?.frameid ?? frameIdFor(draw.id);
    const placed = tag(placeAt(converted, spot.x, spot.y, 1), src.key, groupIdFor(draw.id)).map((el) =>
        patch(el, { opacity: PENDING_OPACITY, frameId })
    );
    const fb = boundsOf(placed) ?? { minX: spot.x, minY: spot.y, maxX: spot.x, maxY: spot.y };
    const frame = newFrame(frameId, `Pending redraw · ${draw.ask || draw.source.title}`, src.key, fb, now);
    // excalidraw keeps a frame after its children
    const elements = [...rest, ...placed, frame];
    return withSource(
        { ...scene, elements },
        {
            ...src,
            editedts: src.editedts || now,
            pending: {
                drawid: draw.id,
                drawnts: now,
                frameid: frameId,
                shapes: draw.shapes,
                skeleton: draw.skeleton,
                cursorts: draw.cursorts,
            },
        }
    );
}

function untag(el: ExcalidrawElement, now: number): ExcalidrawElement {
    const { [ARC_SOURCE]: _, ...rest } = el.customData ?? {};
    return patch(el, {
        customData: Object.keys(rest).length > 0 ? rest : undefined,
        version: el.version + 1,
        updated: now,
    });
}

// the frame goes, the redraw becomes the source's group at full opacity, and the edited group's elements lose
// their tag so they count among Your shapes.
export function keepPending(scene: BoardScene, key: string, now: number): BoardScene {
    const src = (scene.arc.sources ?? []).find((s) => s.key === key);
    const pending = src?.pending;
    if (src == null || pending == null) {
        return scene;
    }
    const groupId = groupIdFor(pending.drawid);
    const elements: ExcalidrawElement[] = [];
    for (const el of scene.elements) {
        if (isPendingPart(el, key, pending)) {
            if (el.id !== pending.frameid) {
                elements.push(
                    patch(el, { frameId: null, opacity: FULL_OPACITY, version: el.version + 1, updated: now })
                );
            }
        } else if (sourceOf(el) === key && el.groupIds.includes(src.groupid)) {
            elements.push(untag(el, now));
        } else {
            elements.push(el);
        }
    }
    const kept = elements.filter((el) => inGroup(el, groupId));
    const b = boundsOf(kept);
    return withSource(
        { ...scene, elements },
        {
            ...src,
            groupid: groupId,
            drawnts: pending.drawnts,
            shapes: pending.shapes,
            contenthash: contentHash(elements, groupId),
            editedts: undefined,
            box: naturalBox(kept, b?.minX ?? 0, b?.minY ?? 0),
            skeleton: pending.skeleton,
            cursorts: pending.cursorts,
            pending: undefined,
        }
    );
}

// the frame and its elements go; the edited group stays the source's group, still edited.
export function dropPending(scene: BoardScene, key: string): BoardScene {
    const src = (scene.arc.sources ?? []).find((s) => s.key === key);
    const pending = src?.pending;
    if (src == null || pending == null) {
        return scene;
    }
    const elements = scene.elements.filter((el) => !isPendingPart(el, key, pending));
    return withSource({ ...scene, elements }, { ...src, pending: undefined });
}

export function groupElementIds(scene: BoardScene, key: string): string[] {
    const src = (scene.arc.sources ?? []).find((s) => s.key === key);
    if (src == null) {
        return [];
    }
    return scene.elements.filter((el) => inGroup(el, src.groupid)).map((el) => el.id);
}

// --- a drawer answer (decision 6), a copied drawing (decision 11), the selection's name (decision 5)

export interface AnswerResult {
    scene: BoardScene;
    shapeIds: string[]; // added + changed: what Show selects and the ack sends
    textIds: string[]; // text whose words or container changed: landAnswer re-measures these
}

interface AnswerUpdate {
    id: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    text?: string;
    label?: string;
    strokeColor?: string;
    backgroundColor?: string;
}

const PATCHED_PROPS = ["x", "y", "width", "height", "strokeColor", "backgroundColor"] as const;

// excalidraw's defaults for a new label: Excalifont, 20px
const LABEL_FONT_SIZE = 20;
const LABEL_FONT_FAMILY = 5;
const LABEL_LINE_HEIGHT = 1.25;

function isBoundText(el: ExcalidrawElement): boolean {
    return el.type === "text" && el.containerId != null;
}

function bump(el: ExcalidrawElement, props: Record<string, unknown>, now: number): ExcalidrawElement {
    return patch(el, { ...props, version: el.version + 1, updated: now });
}

function parseUpdates(update: string | undefined): AnswerUpdate[] {
    if (!update) {
        return [];
    }
    const parsed: unknown = JSON.parse(update);
    if (!Array.isArray(parsed)) {
        throw new Error("the answer's update is not a list");
    }
    return parsed as AnswerUpdate[];
}

function boundTextAt(els: readonly ExcalidrawElement[], containerId: string): number {
    return els.findIndex((el) => !el.isDeleted && el.type === "text" && el.containerId === containerId);
}

// placed at the container's center; landAnswer measures it and centers it for real
function newBoundText(container: ExcalidrawElement, label: string, now: number): ExcalidrawElement {
    const b = elementBounds(container);
    const h = LABEL_FONT_SIZE * LABEL_LINE_HEIGHT;
    return newElement(`${container.id}-label-${now.toString(36)}`, now, {
        type: "text",
        x: (b.minX + b.maxX) / 2,
        y: (b.minY + b.maxY) / 2 - h / 2,
        width: 0,
        height: h,
        strokeColor: container.strokeColor,
        text: label,
        originalText: label,
        fontSize: LABEL_FONT_SIZE,
        fontFamily: LABEL_FONT_FAMILY,
        textAlign: "center",
        verticalAlign: "middle",
        containerId: container.id,
        autoResize: true,
        lineHeight: LABEL_LINE_HEIGHT,
    });
}

function scaledPoints(el: ExcalidrawElement, width: number, height: number): [number, number][] | undefined {
    if (!("points" in el)) {
        return undefined;
    }
    const sx = el.width > 0 ? width / el.width : 1;
    const sy = el.height > 0 ? height / el.height : 1;
    return el.points.map((p) => [p[0] * sx, p[1] * sy]);
}

// patches els[i] in place (els is the caller's working copy); a moved container takes its bound text along.
function applyUpdate(els: ExcalidrawElement[], i: number, u: AnswerUpdate, now: number, textIds: string[]): void {
    const el = els[i];
    const props: Record<string, unknown> = {};
    for (const key of PATCHED_PROPS) {
        if (u[key] != null) {
            props[key] = u[key];
        }
    }
    if (u.width != null || u.height != null) {
        const points = scaledPoints(el, u.width ?? el.width, u.height ?? el.height);
        if (points != null) {
            props.points = points;
        }
    }
    if (u.text != null && el.type === "text") {
        props.text = u.text;
        props.originalText = u.text;
        textIds.push(el.id);
    }
    els[i] = bump(el, props, now);
    if (el.type === "text") {
        return;
    }
    const t = boundTextAt(els, el.id);
    if (t < 0) {
        if (u.label != null) {
            const label = newBoundText(els[i], u.label, now);
            els[i] = patch(els[i], {
                boundElements: [...(els[i].boundElements ?? []), { type: "text", id: label.id }],
            });
            els.push(label);
            textIds.push(label.id);
        }
        return;
    }
    const dx = (u.x ?? el.x) - el.x;
    const dy = (u.y ?? el.y) - el.y;
    const textProps: Record<string, unknown> = {};
    if (dx !== 0 || dy !== 0) {
        textProps.x = els[t].x + dx;
        textProps.y = els[t].y + dy;
    }
    if (u.label != null) {
        textProps.text = u.label;
        textProps.originalText = u.label;
    }
    if (Object.keys(textProps).length > 0) {
        els[t] = bump(els[t], textProps, now);
    }
    if (u.label != null || u.width != null || u.height != null) {
        textIds.push(els[t].id);
    }
}

// added (already converted) goes on top; update and remove skip ids the board no longer has, since you may have
// deleted them while the drawer answered. Arrows bound to a moved shape are not re-routed (decision 6).
export function applyAnswer(
    scene: BoardScene,
    answer: BoardAnswer,
    added: readonly ExcalidrawElement[],
    now: number
): AnswerResult {
    const els = [...scene.elements, ...added];
    const liveAt = (id: string): number => els.findIndex((el) => el.id === id && !el.isDeleted);
    const shapeIds = added.filter((el) => !isBoundText(el)).map((el) => el.id);
    const textIds: string[] = [];
    for (const u of parseUpdates(answer.update)) {
        const i = liveAt(u.id);
        if (i >= 0) {
            applyUpdate(els, i, u, now, textIds);
            shapeIds.push(u.id);
        }
    }
    for (const id of answer.remove ?? []) {
        const i = liveAt(id);
        if (i < 0) {
            continue;
        }
        const t = boundTextAt(els, id);
        els[i] = bump(els[i], { isDeleted: true }, now);
        if (t >= 0) {
            els[t] = bump(els[t], { isDeleted: true }, now);
        }
    }
    return {
        scene: { ...scene, elements: els },
        shapeIds: [...new Set(shapeIds)].filter((id) => liveAt(id) >= 0),
        textIds: [...new Set(textIds)].filter((id) => liveAt(id) >= 0),
    };
}

function randomId(): string {
    return crypto.randomUUID();
}

// a handed-over board's drawing: every live element under a new id, with containers, bindings, groups and frames
// pointing at the copies; a reference to an element not copied is dropped.
export function copyElements(
    elements: readonly ExcalidrawElement[],
    newId: () => string = randomId
): ExcalidrawElement[] {
    const kept = live(elements);
    const ids = new Map(kept.map((el) => [el.id, newId()]));
    const groups = new Map<string, string>();
    const groupId = (g: string): string => {
        if (!groups.has(g)) {
            groups.set(g, newId());
        }
        return groups.get(g);
    };
    const ref = (id: string | null | undefined): string | null => (id == null ? null : (ids.get(id) ?? null));
    const binding = <B extends { elementId: string }>(b: B | null): B | null =>
        b != null && ids.has(b.elementId) ? { ...b, elementId: ids.get(b.elementId) } : null;
    return kept.map((el) => {
        const props: Record<string, unknown> = {
            id: ids.get(el.id),
            groupIds: el.groupIds.map(groupId),
            frameId: ref(el.frameId),
            boundElements:
                el.boundElements?.filter((b) => ids.has(b.id)).map((b) => ({ ...b, id: ids.get(b.id) })) ?? null,
        };
        if (el.type === "text") {
            props.containerId = ref(el.containerId);
        }
        if ("startBinding" in el) {
            props.startBinding = binding(el.startBinding);
            props.endBinding = binding(el.endBinding);
        }
        return patch(el, props);
    });
}

function oneLine(s: string): string {
    return s.replace(/\s+/g, " ").trim();
}

// "wavesrv", "wavesrv and 2 more" (the first selected shape with words), "3 shapes" when none has words; a
// selected container's own bound text is part of it, not one more.
export function selectionLabel(elements: readonly ExcalidrawElement[], selectedIds: readonly string[]): string | null {
    const shown = live(elements);
    const byId = new Map(shown.map((el) => [el.id, el]));
    const labels = new Map<string, string>();
    for (const el of shown) {
        if (el.type === "text" && el.containerId != null) {
            labels.set(el.containerId, elementText(el));
        }
    }
    const chosen = new Set(selectedIds);
    const shapes = [...chosen]
        .map((id) => byId.get(id))
        .filter((el) => el != null && !(el.type === "text" && el.containerId != null && chosen.has(el.containerId)));
    if (shapes.length === 0) {
        return null;
    }
    const name = shapes
        .map((el) => oneLine(el.type === "text" ? elementText(el) : (labels.get(el.id) ?? "")))
        .find((s) => s !== "");
    if (name == null) {
        return plural(shapes.length, "shape");
    }
    return shapes.length === 1 ? name : `${name} and ${shapes.length - 1} more`;
}

// a labelled box is one shape (decision 8)
export function shapeCount(elements: readonly ExcalidrawElement[]): number {
    return live(elements).filter((el) => !isBoundText(el) && el.type !== "selection").length;
}

// --- what the surface shows

export interface BoardSourceRow {
    key: string;
    kindIcon: string;
    title: string;
    subline: string;
    isNew: boolean;
    state: "drawn" | "drawing" | "failed" | "pending";
    pending?: { editedTs: number; drawnTs: number };
    status?: BoardSourceStatus;
}

function pad2(n: number): string {
    return String(n).padStart(2, "0");
}

export function boardTime(ts: number, now: number): string {
    const d = new Date(ts);
    const today = new Date(now);
    const sameDay =
        d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
    return sameDay ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function whatItReads(source: BoardSource, ask: string | undefined): string {
    if (ask) {
        return source.title;
    }
    return READ_WHOLE_KINDS.has(source.kind) ? "no ask, read whole" : "no ask";
}

export function sourceRows(
    arc: BoardArcRecord,
    status: BoardSourceStatus[],
    seenTs: number,
    now: number = Date.now()
): BoardSourceRow[] {
    const statusByKey = new Map(status.map((s) => [s.sourcekey, s]));
    const sources = [...(arc.sources ?? [])].sort((a, b) => b.drawnts - a.drawnts);
    const rows: BoardSourceRow[] = sources.map((src) => {
        const st = statusByKey.get(src.key);
        const state = st != null ? (st.state as "drawing" | "failed") : src.pending != null ? "pending" : "drawn";
        const row: BoardSourceRow = {
            key: src.key,
            kindIcon: src.source.kind,
            title: src.ask || src.source.title,
            subline: [whatItReads(src.source, src.ask), plural(src.shapes, "shape"), boardTime(src.drawnts, now)].join(
                " · "
            ),
            isNew: src.drawnts > seenTs,
            state,
        };
        if (src.pending != null) {
            row.pending = { editedTs: src.editedts ?? 0, drawnTs: src.pending.drawnts };
        }
        if (st != null) {
            row.status = st;
        }
        return row;
    });
    const drawn = new Set(sources.map((s) => s.key));
    for (const st of status) {
        if (drawn.has(st.sourcekey)) {
            continue;
        }
        rows.push({
            key: st.sourcekey,
            kindIcon: st.source.kind,
            title: st.ask || st.source.title,
            subline: whatItReads(st.source, st.ask),
            isNew: false,
            state: st.state as "drawing" | "failed",
            status: st,
        });
    }
    return rows;
}

// text counts as a note, everything else as a shape; a container's bound label is part of its container.
export function yourShapesLabel(elements: readonly ExcalidrawElement[]): string {
    let notes = 0;
    let shapes = 0;
    for (const el of live(elements)) {
        if (sourceOf(el) != null || el.type === "selection") {
            continue;
        }
        if (el.type === "text") {
            if (el.containerId == null) {
                notes++;
            }
        } else {
            shapes++;
        }
    }
    const parts: string[] = [];
    if (notes > 0) {
        parts.push(plural(notes, "note"));
    }
    if (shapes > 0 || notes === 0) {
        parts.push(plural(shapes, "shape"));
    }
    return parts.join(", ");
}

function newCount(arc: BoardArcRecord, seenTs: number): number {
    return (arc.sources ?? []).filter((s) => s.drawnts > seenTs).length;
}

export function headerFacts(arc: BoardArcRecord, seenTs: number, now: number): string {
    const sources = arc.sources ?? [];
    const facts = [plural(sources.length, "group")];
    const fresh = newCount(arc, seenTs);
    if (fresh > 0) {
        facts.push(`${fresh} new since you looked`);
    }
    if (sources.length > 0) {
        facts.push(`last drawn ${boardTime(Math.max(...sources.map((s) => s.drawnts)), now)}`);
    }
    return facts.join(" · ");
}

export function newestSinceSeen(arc: BoardArcRecord, seenTs: number): string | null {
    let best: BoardArcSource | null = null;
    for (const s of arc.sources ?? []) {
        if (s.drawnts > seenTs && (best == null || s.drawnts > best.drawnts)) {
            best = s;
        }
    }
    return best?.key ?? null;
}

export interface BoardFollowMeta {
    boardId: string;
    channelId: string;
    boardName: string;
    ask: string;
}

export function followOf(meta: MetaType | undefined): BoardFollowMeta | null {
    const boardId = meta?.["board:followid"];
    if (!boardId) {
        return null;
    }
    return {
        boardId,
        channelId: meta["board:followchannel"] ?? "",
        boardName: meta["board:followname"] ?? "",
        ask: meta["board:followask"] ?? "",
    };
}
