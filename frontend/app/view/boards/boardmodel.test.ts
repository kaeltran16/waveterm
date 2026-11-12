import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { describe, expect, it } from "vitest";
import {
    ARC_SOURCE,
    BoardFileError,
    applyDraw,
    boardTime,
    contentHash,
    dropPending,
    followOf,
    groupElementIds,
    headerFacts,
    keepPending,
    markEdits,
    newestSinceSeen,
    parseBoardFile,
    serializeBoard,
    sourceRows,
    yourShapesLabel,
    type BoardScene,
} from "./boardmodel";

const NOW = new Date(2026, 10, 12, 16, 4).getTime();

function base(id: string, type: string, x: number, y: number, w: number, h: number, extra: object = {}) {
    return {
        id,
        type,
        x,
        y,
        width: w,
        height: h,
        strokeColor: "#1e1e1e",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 2,
        strokeStyle: "solid",
        roundness: null,
        roughness: 1,
        opacity: 100,
        angle: 0,
        seed: 1,
        version: 1,
        versionNonce: 1,
        index: null,
        isDeleted: false,
        groupIds: [],
        frameId: null,
        boundElements: null,
        updated: 1,
        link: null,
        locked: false,
        ...extra,
    } as unknown as ExcalidrawElement;
}

function rect(id: string, x: number, y: number, w: number, h: number, extra: object = {}) {
    return base(id, "rectangle", x, y, w, h, extra);
}

function text(id: string, x: number, y: number, t: string, extra: object = {}) {
    return base(id, "text", x, y, t.length * 10, 20, {
        text: t,
        originalText: t,
        fontSize: 20,
        fontFamily: 5,
        textAlign: "left",
        verticalAlign: "top",
        containerId: null,
        autoResize: true,
        lineHeight: 1.25,
        ...extra,
    });
}

function arrow(id: string, x: number, y: number, dx: number, dy: number) {
    return base(id, "arrow", x, y, Math.abs(dx), Math.abs(dy), {
        points: [
            [0, 0],
            [dx, dy],
        ],
    });
}

function emptyScene(elements: ExcalidrawElement[] = []): BoardScene {
    return { arc: { name: "Brainstorm internals", createdts: 1 }, elements, appState: {}, files: {} };
}

const runSource: BoardSource = { kind: "run", ref: "690cc20a", channelid: "ch1", title: "run 690cc20a" };
const agentSource: BoardSource = { kind: "agent", ref: "tab1", title: "claude · waveterm" };

function draw(id: string, extra: Partial<BoardDraw> = {}): BoardDraw {
    return {
        id,
        channelid: "ch1",
        boardid: "0a1b2c3d",
        sourcekey: "agent:tab1|the escalation flow",
        source: agentSource,
        ask: "the escalation flow",
        skeleton: "[]",
        shapes: 2,
        ts: NOW,
        ...extra,
    };
}

// a scribe result as convertToExcalidrawElements returns it: positioned anywhere
function converted(prefix: string, label = "start"): ExcalidrawElement[] {
    return [
        rect(`${prefix}-r`, 500, 500, 100, 40),
        text(`${prefix}-t`, 510, 510, label),
        arrow(`${prefix}-a`, 600, 520, 100, 0),
    ];
}

function bounds(els: readonly ExcalidrawElement[]) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const el of els) {
        const pts = (el as any).points as [number, number][] | undefined;
        if (pts) {
            for (const p of pts) {
                xs.push(el.x + p[0]);
                ys.push(el.y + p[1]);
            }
        } else {
            xs.push(el.x, el.x + el.width);
            ys.push(el.y, el.y + el.height);
        }
    }
    return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

function sourceAt(scene: BoardScene, key = draw("x").sourcekey) {
    return scene.arc.sources!.find((s) => s.key === key)!;
}

function groupOf(scene: BoardScene, key?: string) {
    const ids = new Set(groupElementIds(scene, key ?? draw("x").sourcekey));
    return scene.elements.filter((el) => ids.has(el.id));
}

const userNote = text("user-note", 0, 0, "my note");
const userRect = rect("user-rect", 0, 40, 100, 60);

function drawnOnce(): BoardScene {
    return applyDraw(emptyScene([userNote, userRect]), draw("d1"), converted("d1"), NOW).scene;
}

function editText(scene: BoardScene, id: string, t: string): BoardScene {
    return {
        ...scene,
        elements: scene.elements.map((el) =>
            el.id === id ? ({ ...el, text: t, originalText: t } as ExcalidrawElement) : el
        ),
    };
}

describe("parseBoardFile / serializeBoard", () => {
    it("round-trips and keeps arc as the first key", () => {
        const scene = drawnOnce();
        const textOut = serializeBoard(scene);
        expect(Object.keys(JSON.parse(textOut))[0]).toBe("arc");
        expect(textOut.indexOf('"arc"')).toBeLessThan(textOut.indexOf('"elements"'));
        const back = parseBoardFile(textOut);
        expect(back.arc).toEqual(JSON.parse(JSON.stringify(scene.arc)));
        expect(back.elements).toEqual(JSON.parse(JSON.stringify(scene.elements)));
    });

    it("drops deleted elements when saving", () => {
        const scene = emptyScene([userRect, { ...userNote, isDeleted: true } as ExcalidrawElement]);
        expect(parseBoardFile(serializeBoard(scene)).elements.map((el) => el.id)).toEqual(["user-rect"]);
    });

    it("refuses a damaged file", () => {
        const good = serializeBoard(drawnOnce());
        expect(() => parseBoardFile(good.slice(0, good.length - 40))).toThrow(BoardFileError);
        expect(() => parseBoardFile("[]")).toThrow(BoardFileError);
        expect(() => parseBoardFile('{"type":"excalidraw","elements":[]}')).toThrow(/no arc record/);
        expect(() => parseBoardFile('{"arc":{"name":"x"},"elements":{}}')).toThrow(/elements/);
    });
});

describe("contentHash", () => {
    const g = "grp";
    const els = [rect("a", 0, 0, 10, 10, { groupIds: [g] }), text("b", 0, 0, "hi", { groupIds: [g] })];
    const h = contentHash(els, g);

    it("ignores moving, resizing and restyling", () => {
        const moved = els.map(
            (el) => ({ ...el, x: el.x + 50, width: el.width * 3, strokeColor: "#f00" }) as ExcalidrawElement
        );
        expect(contentHash(moved, g)).toBe(h);
    });

    it("ignores a container rewrapping its label", () => {
        const rewrapped = els.map((el) => (el.id === "b" ? ({ ...el, text: "h\ni" } as ExcalidrawElement) : el));
        expect(contentHash(rewrapped, g)).toBe(h);
    });

    it("changes on a text edit, an added element and a deleted one", () => {
        expect(contentHash(editText({ ...emptyScene(els) }, "b", "hello").elements, g)).not.toBe(h);
        expect(contentHash([...els, rect("c", 0, 0, 1, 1, { groupIds: [g] })], g)).not.toBe(h);
        expect(contentHash([els[0]], g)).not.toBe(h);
        expect(contentHash([els[0], { ...els[1], isDeleted: true } as ExcalidrawElement], g)).not.toBe(h);
    });

    it("only counts the group's elements", () => {
        expect(contentHash([...els, rect("z", 0, 0, 1, 1)], g)).toBe(h);
    });
});

describe("applyDraw", () => {
    it("places a first draw 120px right of the board's content, top-aligned, tagged", () => {
        const { scene, outcome } = applyDraw(emptyScene([userNote, userRect]), draw("d1"), converted("d1"), NOW);
        expect(outcome).toBe("new");
        const group = groupOf(scene);
        expect(group).toHaveLength(3);
        const content = bounds([userNote, userRect]);
        expect(bounds(group).minX).toBe(content.maxX + 120);
        expect(bounds(group).minY).toBe(content.minY);
        const src = sourceAt(scene);
        for (const el of group) {
            expect(el.customData?.[ARC_SOURCE]).toBe(src.key);
            expect(el.groupIds.at(-1)).toBe(src.groupid);
        }
        expect(src).toMatchObject({ drawnts: NOW, shapes: 2, ask: "the escalation flow", source: agentSource });
        expect(src.contenthash).toBe(contentHash(scene.elements, src.groupid));
        expect(src.box).toEqual({ x: content.maxX + 120, y: content.minY, w: 200, h: 40 });
    });

    it("places a first draw on an empty board at the origin", () => {
        const { scene } = applyDraw(emptyScene(), draw("d1"), converted("d1"), NOW);
        expect(bounds(scene.elements)).toMatchObject({ minX: 0, minY: 0 });
    });

    it("replaces an unedited group in place, at its current top-left and scale", () => {
        const first = drawnOnce();
        const src = sourceAt(first);
        const old = bounds(groupOf(first));
        // the user moves the group by (+50, +30) and resizes it 2x about its top-left
        const resized = {
            ...first,
            elements: first.elements.map((el) => {
                if (!el.groupIds.includes(src.groupid)) {
                    return el;
                }
                const pts = (el as any).points as [number, number][] | undefined;
                return {
                    ...el,
                    x: old.minX + 50 + (el.x - old.minX) * 2,
                    y: old.minY + 30 + (el.y - old.minY) * 2,
                    width: el.width * 2,
                    height: el.height * 2,
                    ...(pts ? { points: pts.map((p) => [p[0] * 2, p[1] * 2]) } : {}),
                } as ExcalidrawElement;
            }),
        };
        expect(markEdits(resized, NOW + 1)).toBe(resized);
        const redraw = [rect("d2-r", 0, 0, 60, 30), text("d2-t", 5, 5, "next")];
        const { scene, outcome } = applyDraw(resized, draw("d2", { shapes: 1 }), redraw, NOW + 2);
        expect(outcome).toBe("replaced");
        const group = groupOf(scene);
        expect(group.map((el) => el.id).sort()).toEqual(["d2-r", "d2-t"]);
        const b = bounds(group);
        expect(b.minX).toBe(old.minX + 50);
        expect(b.minY).toBe(old.minY + 30);
        expect(b.maxX - b.minX).toBe(120);
        expect(group.find((el) => el.id === "d2-t")).toMatchObject({ fontSize: 40 });
        expect(sourceAt(scene)).toMatchObject({
            groupid: src.groupid,
            shapes: 1,
            drawnts: NOW + 2,
            box: { w: 60, h: 30 },
        });
        expect(scene.elements.filter((el) => el.id.startsWith("d1-"))).toHaveLength(0);

        // no further resize: the next redraw stays 2x
        const again = applyDraw(scene, draw("d3"), [rect("d3-r", 0, 0, 10, 10)], NOW + 3).scene;
        expect(bounds(groupOf(again)).maxX - bounds(groupOf(again)).minX).toBe(20);
    });

    it("lands a redraw of an edited group as a faded pending frame 80px right of it", () => {
        const edited = markEdits(editText(drawnOnce(), "d1-t", "my words"), NOW + 1);
        expect(sourceAt(edited).editedts).toBe(NOW + 1);
        const groupBefore = groupOf(edited);
        const { scene, outcome } = applyDraw(edited, draw("d2"), converted("d2", "redrawn"), NOW + 2);
        expect(outcome).toBe("pending");
        const src = sourceAt(scene);
        expect(src.pending).toMatchObject({ drawid: "d2", drawnts: NOW + 2, shapes: 2 });
        const frame = scene.elements.find((el) => el.id === src.pending!.frameid)!;
        expect(frame.type).toBe("frame");
        expect((frame as any).name).toBe("Pending redraw · the escalation flow");
        const g = bounds(groupBefore);
        expect(frame.x).toBe(g.maxX + 80);
        expect(frame.y).toBe(g.minY);
        const children = scene.elements.filter((el) => el.frameId === frame.id);
        expect(children.map((el) => el.id).sort()).toEqual(["d2-a", "d2-r", "d2-t"]);
        expect(children.every((el) => el.opacity === 40)).toBe(true);
        // the edited group is untouched and still the source's
        expect(groupOf(scene)).toEqual(groupBefore);
    });

    it("places a pending frame past the board's content when the spot beside the edited group is taken", () => {
        const drawn = drawnOnce();
        const a = bounds(groupOf(drawn));
        const groupB = [rect("b-r", a.maxX + 40, a.minY, 100, 40, { groupIds: ["user-b"] })];
        const edited = editText({ ...drawn, elements: [...drawn.elements, ...groupB] }, "d1-t", "my words");
        const { scene, outcome } = applyDraw(edited, draw("d2"), converted("d2"), NOW + 2);
        expect(outcome).toBe("pending");
        const frame = scene.elements.find((el) => el.id === sourceAt(scene).pending!.frameid)!;
        const f = bounds([frame]);
        const b = bounds(groupB);
        const overlaps = f.minX < b.maxX && b.minX < f.maxX && f.minY < b.maxY && b.minY < f.maxY;
        expect(overlaps).toBe(false);
        expect(f.minX).toBeGreaterThanOrEqual(b.maxX + 120);
        expect(f.minY).toBe(a.minY);
    });

    it("names the pending frame after the source when there is no ask", () => {
        const d = draw("d1", { sourcekey: "run:690cc20a", source: runSource, ask: undefined });
        const first = applyDraw(emptyScene(), d, converted("d1"), NOW).scene;
        const edited = editText(first, "d1-t", "mine");
        const { scene } = applyDraw(edited, { ...d, id: "d2" }, converted("d2"), NOW + 1);
        const frame = scene.elements.find((el) => el.type === "frame")!;
        expect((frame as any).name).toBe("Pending redraw · run 690cc20a");
    });

    it("treats an edit the autosave hasn't stamped yet as an edit", () => {
        const { scene, outcome } = applyDraw(editText(drawnOnce(), "d1-t", "x"), draw("d2"), converted("d2"), NOW + 2);
        expect(outcome).toBe("pending");
        expect(sourceAt(scene).editedts).toBe(NOW + 2);
    });

    it("replaces the pending frame's contents on a second redraw", () => {
        const edited = editText(drawnOnce(), "d1-t", "mine");
        const once = applyDraw(edited, draw("d2"), converted("d2"), NOW + 2).scene;
        const frameId = sourceAt(once).pending!.frameid;
        const { scene, outcome } = applyDraw(once, draw("d3", { shapes: 1 }), [rect("d3-r", 0, 0, 30, 30)], NOW + 3);
        expect(outcome).toBe("pending");
        expect(scene.elements.filter((el) => el.type === "frame")).toHaveLength(1);
        expect(scene.elements.filter((el) => el.frameId === frameId).map((el) => el.id)).toEqual(["d3-r"]);
        expect(scene.elements.some((el) => el.id.startsWith("d2-"))).toBe(false);
        expect(sourceAt(scene).pending).toMatchObject({ drawid: "d3", frameid: frameId, shapes: 1 });
    });

    it("never touches the user's shapes", () => {
        let scene = drawnOnce();
        scene = applyDraw(scene, draw("d2"), converted("d2"), NOW + 1).scene;
        scene = editText(scene, "d2-t", "mine");
        scene = applyDraw(scene, draw("d3"), converted("d3"), NOW + 2).scene;
        scene = applyDraw(scene, draw("d4"), converted("d4"), NOW + 3).scene;
        expect(scene.elements.find((el) => el.id === "user-note")).toBe(userNote);
        expect(scene.elements.find((el) => el.id === "user-rect")).toBe(userRect);
        expect(keepPending(scene, sourceAt(scene).key, NOW + 4).elements.find((el) => el.id === "user-rect")).toBe(
            userRect
        );
        expect(dropPending(scene, sourceAt(scene).key).elements.find((el) => el.id === "user-note")).toBe(userNote);
    });
});

describe("keepPending / dropPending", () => {
    function pendingScene() {
        const edited = markEdits(editText(drawnOnce(), "d1-t", "mine"), NOW + 1);
        return applyDraw(edited, draw("d2"), converted("d2"), NOW + 2).scene;
    }

    it("keep makes the redraw the group and hands the edited one to the user", () => {
        const before = pendingScene();
        const key = sourceAt(before).key;
        const oldGroup = sourceAt(before).groupid;
        const scene = keepPending(before, key, NOW + 5);
        const src = sourceAt(scene);
        expect(src.pending).toBeUndefined();
        expect(src.editedts).toBeUndefined();
        expect(src.groupid).not.toBe(oldGroup);
        expect(src.drawnts).toBe(NOW + 2);
        expect(scene.elements.some((el) => el.type === "frame")).toBe(false);
        expect(
            groupOf(scene)
                .map((el) => el.id)
                .sort()
        ).toEqual(["d2-a", "d2-r", "d2-t"]);
        expect(groupOf(scene).every((el) => el.opacity === 100 && el.frameId == null)).toBe(true);
        expect(src.contenthash).toBe(contentHash(scene.elements, src.groupid));
        const formerlyScribe = scene.elements.filter((el) => el.id.startsWith("d1-"));
        expect(formerlyScribe).toHaveLength(3);
        expect(formerlyScribe.every((el) => el.customData?.[ARC_SOURCE] == null)).toBe(true);
        // user note + note "mine" + rect + 2 former scribe shapes
        expect(yourShapesLabel(scene.elements)).toBe("2 notes, 3 shapes");
        // a later unedited redraw replaces in place
        expect(applyDraw(scene, draw("d3"), converted("d3"), NOW + 6).outcome).toBe("replaced");
    });

    it("drop deletes the frame and leaves the edited group edited", () => {
        const before = pendingScene();
        const key = sourceAt(before).key;
        const scene = dropPending(before, key);
        const src = sourceAt(scene);
        expect(src.pending).toBeUndefined();
        expect(src.editedts).toBe(NOW + 1);
        expect(src.groupid).toBe(sourceAt(before).groupid);
        expect(scene.elements.some((el) => el.type === "frame" || el.id.startsWith("d2-"))).toBe(false);
        expect(
            groupOf(scene)
                .map((el) => el.id)
                .sort()
        ).toEqual(["d1-a", "d1-r", "d1-t"]);
        expect(applyDraw(scene, draw("d3"), converted("d3"), NOW + 6).outcome).toBe("pending");
    });

    it("are no-ops without a pending version", () => {
        const scene = drawnOnce();
        expect(keepPending(scene, sourceAt(scene).key, NOW)).toBe(scene);
        expect(dropPending(scene, "nope")).toBe(scene);
    });
});

describe("rows and facts", () => {
    const at = (h: number, m: number) => new Date(2026, 10, 12, h, m).getTime();
    const src = (key: string, extra: Partial<BoardArcSource>): BoardArcSource => ({
        key,
        source: runSource,
        groupid: `g-${key}`,
        drawnts: at(15, 20),
        shapes: 6,
        contenthash: "h",
        skeleton: "[]",
        ...extra,
    });
    const arc: BoardArcRecord = {
        name: "Brainstorm internals",
        createdts: 1,
        sources: [
            src("run:690cc20a", {}),
            src("agent:tab1|the escalation flow", {
                source: agentSource,
                ask: "the escalation flow",
                drawnts: at(16, 4),
                shapes: 1,
                editedts: at(16, 1),
                pending: { drawid: "d9", drawnts: at(16, 4), frameid: "f", shapes: 3, skeleton: "[]" },
            }),
        ],
    };

    it("sourceRows: newest first, sublines per decision 18, then first draws in progress", () => {
        const drawing: BoardSourceStatus = {
            sourcekey: "effort:e1",
            source: { kind: "effort", ref: "e1", title: "Boards" },
            state: "drawing",
            reading: "the initiative, read whole",
            ts: NOW,
        };
        const rows = sourceRows(arc, [drawing], at(16, 0), NOW);
        expect(rows.map((r) => r.key)).toEqual(["agent:tab1|the escalation flow", "run:690cc20a", "effort:e1"]);
        expect(rows[0]).toMatchObject({
            kindIcon: "agent",
            title: "the escalation flow",
            subline: "claude · waveterm · 1 shape · 16:04",
            isNew: true,
            state: "pending",
            pending: { editedTs: at(16, 1), drawnTs: at(16, 4) },
        });
        expect(rows[1]).toMatchObject({
            kindIcon: "run",
            title: "run 690cc20a",
            subline: "no ask, read whole · 6 shapes · 15:20",
            isNew: false,
            state: "drawn",
        });
        expect(rows[2]).toMatchObject({ kindIcon: "effort", title: "Boards", state: "drawing", status: drawing });
    });

    it("sourceRows: a live status wins over pending; an agent with no ask is not read whole", () => {
        const failed: BoardSourceStatus = {
            ...{ sourcekey: "agent:tab1|the escalation flow", source: agentSource },
            state: "failed",
            reason: "timed out",
            ts: NOW,
        };
        const rows = sourceRows(arc, [failed], 0, NOW);
        expect(rows[0]).toMatchObject({ state: "failed", status: failed });
        const noAsk = sourceRows({ ...arc, sources: [src("agent:tab1", { source: agentSource })] }, [], 0, NOW);
        expect(noAsk[0].subline).toBe("no ask · 6 shapes · 15:20");
    });

    it("yourShapesLabel counts the user's notes and shapes, not the scribe's", () => {
        expect(yourShapesLabel([userNote])).toBe("1 note");
        expect(yourShapesLabel([userNote, userRect, rect("r2", 0, 0, 1, 1)])).toBe("1 note, 2 shapes");
        expect(yourShapesLabel([userRect, rect("r2", 0, 0, 1, 1), rect("r3", 0, 0, 1, 1)])).toBe("3 shapes");
        expect(yourShapesLabel(drawnOnce().elements)).toBe("1 note, 1 shape");
        expect(yourShapesLabel([text("lbl", 0, 0, "label", { containerId: "user-rect" }), userRect])).toBe("1 shape");
        expect(yourShapesLabel([])).toBe("0 shapes");
    });

    it("headerFacts omits the new clause at zero", () => {
        expect(headerFacts(arc, at(16, 0), NOW)).toBe("2 groups · 1 new since you looked · last drawn 16:04");
        expect(headerFacts(arc, at(17, 0), NOW)).toBe("2 groups · last drawn 16:04");
        expect(headerFacts({ name: "x", createdts: 1 }, 0, NOW)).toBe("0 groups");
    });

    it("newestSinceSeen picks the newest source drawn after the last look", () => {
        expect(newestSinceSeen(arc, at(15, 0))).toBe("agent:tab1|the escalation flow");
        expect(newestSinceSeen(arc, at(17, 0))).toBeNull();
    });

    it("boardTime is HH:MM today, else MM-DD", () => {
        expect(boardTime(at(9, 5), NOW)).toBe("09:05");
        expect(boardTime(new Date(2026, 10, 11, 23, 59).getTime(), NOW)).toBe("11-11");
    });
});

describe("followOf", () => {
    it("needs board:followid", () => {
        expect(followOf(undefined)).toBeNull();
        expect(followOf({ "board:followname": "x" } as MetaType)).toBeNull();
        expect(
            followOf({
                "board:followid": "0a1b2c3d",
                "board:followchannel": "ch1",
                "board:followname": "Brainstorm internals",
                "board:followask": "the escalation flow",
            } as MetaType)
        ).toEqual({
            boardId: "0a1b2c3d",
            channelId: "ch1",
            boardName: "Brainstorm internals",
            ask: "the escalation flow",
        });
        expect(followOf({ "board:followid": "0a1b2c3d" } as MetaType)).toEqual({
            boardId: "0a1b2c3d",
            channelId: "",
            boardName: "",
            ask: "",
        });
    });
});
