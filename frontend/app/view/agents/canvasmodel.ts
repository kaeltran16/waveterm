// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure: what the canvas pane derives from a design-local folder, its server, and the agent's canvas state.

import type { CanvasState } from "./canvasstore";

export const CANVAS_PORT_FIRST = 8766;
export const CANVAS_PORT_COUNT = 20;
export const CANVAS_POLL_MS = 3000;
export const DEFAULT_BOARD_W = 1440;

const BOARD_EXT = ".dc.html";
const MAIN_BOARD = "Main.dc.html";
const HTTP_OK = 200;

// h is absent when canvas.json has none; the board then fills the pane's height
export type CanvasBoard = { name: string; w: number; h?: number };
export type ProbeResult = { port: number; status: number | "error" };

function isRecord(v: unknown): v is Record<string, unknown> {
    return v != null && typeof v === "object" && !Array.isArray(v);
}

function boardSide(entry: unknown, side: "w" | "h"): number | undefined {
    const v = isRecord(entry) ? entry[side] : undefined;
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

// canvas.json is written by the design-local skill, not by Arc, so anything malformed reads as the one board
// every canvas has rather than as an error
export function boardsFromCanvasJson(json: unknown): CanvasBoard[] {
    const fallback = [{ name: MAIN_BOARD, w: DEFAULT_BOARD_W }];
    if (!isRecord(json) || !isRecord(json.boards)) {
        return fallback;
    }
    const boards = json.boards;
    const known = (n: unknown): n is string => typeof n === "string" && n.endsWith(BOARD_EXT) && n in boards;
    let names = Array.isArray(json.order) ? json.order.filter(known) : [];
    if (names.length === 0) {
        names = Object.keys(boards).filter(known);
        names.sort((a, b) => Number(b === MAIN_BOARD) - Number(a === MAIN_BOARD));
    }
    if (names.length === 0) {
        return fallback;
    }
    return names.map((name) => ({
        name,
        w: boardSide(boards[name], "w") ?? DEFAULT_BOARD_W,
        h: boardSide(boards[name], "h"),
    }));
}

// a board name that isn't in the list (a stale pick, or boards not polled yet) shows the first one
export function shownBoard(s: CanvasState): CanvasBoard {
    return s.boards.find((b) => b.name === s.board) ?? s.boards[0] ?? { name: MAIN_BOARD, w: DEFAULT_BOARD_W };
}

export function boardLabel(name: string): string {
    return name.endsWith(BOARD_EXT) ? name.slice(0, -BOARD_EXT.length) : name;
}

export function stepBoard(boards: CanvasBoard[], current: string | null, delta: number): string | null {
    const n = boards.length;
    if (n === 0) {
        return null;
    }
    const at = Math.max(
        0,
        boards.findIndex((b) => b.name === current)
    );
    return boards[(((at + delta) % n) + n) % n].name;
}

// a refused connection means nothing listens there; any other answer is someone else's server
export function classifyProbe(r: ProbeResult): "serving" | "free" | "taken" {
    if (r.status === HTTP_OK) {
        return "serving";
    }
    return r.status === "error" ? "free" : "taken";
}

function lowestPort(rs: ProbeResult[], kind: "serving" | "free"): number | null {
    const ports = rs.filter((r) => classifyProbe(r) === kind).map((r) => r.port);
    return ports.length === 0 ? null : Math.min(...ports);
}

export function pickServingPort(rs: ProbeResult[]): number | null {
    return lowestPort(rs, "serving");
}

export function pickFreePort(rs: ProbeResult[]): number | null {
    return lowestPort(rs, "free");
}

export function paneState(s: CanvasState): "board" | "probing" | "server-down" | "removed" {
    switch (s.status) {
        case "removed":
            return "removed";
        case "server-down":
            return "server-down";
        case "probing":
            return "probing";
        default:
            return "board";
    }
}

export function isUnseen(s: CanvasState): boolean {
    return s.mode === "terminal" && s.lastModifiedMs != null && s.lastModifiedMs > s.lastViewedMs;
}

export function updatedAgo(nowMs: number, ms: number | null): string {
    if (ms == null) {
        return "";
    }
    const secs = Math.max(0, Math.floor((nowMs - ms) / 1000));
    if (secs < 60) {
        return `updated ${secs}s ago`;
    }
    if (secs < 3600) {
        return `updated ${Math.floor(secs / 60)}m ago`;
    }
    return `updated ${Math.floor(secs / 3600)}h ago`;
}

export function fitScale(paneWidth: number, boardWidth: number): number {
    if (paneWidth <= 0 || boardWidth <= 0) {
        return 1;
    }
    return Math.min(1, paneWidth / boardWidth);
}

// the poller keeps the last port when its server stops answering; null means no port ever served this canvas
export function serverDownText(port: number | null): string {
    if (port != null) {
        return `Can't reach 127.0.0.1:${port}`;
    }
    return `Nothing serves this canvas on 127.0.0.1:${CANVAS_PORT_FIRST}–${CANVAS_PORT_FIRST + CANVAS_PORT_COUNT - 1}`;
}

export function boardUrl(port: number, topic: string, board: string): string {
    return `http://127.0.0.1:${port}/${encodeURIComponent(topic)}/project/${encodeURIComponent(board)}`;
}

function sepOf(path: string): string {
    return path.includes("\\") ? "\\" : "/";
}

function join(base: string, ...parts: string[]): string {
    const sep = sepOf(base);
    return [base.replace(/[\\/]+$/, ""), ...parts].join(sep);
}

// the folder the canvas server is rooted at, which start_canvas_server requires
export function canvasDesignDir(cwd: string): string {
    return join(cwd, ".superpowers", "design");
}

export function canvasDir(cwd: string, topic: string): string {
    return join(canvasDesignDir(cwd), topic);
}

export function canvasProjectDir(dir: string): string {
    return join(dir, "project");
}

export function canvasFeedbackDir(dir: string): string {
    return join(dir, "feedback");
}

export function canvasFeedbackFile(dir: string, name: string): string {
    return join(canvasFeedbackDir(dir), name);
}

export function buildGoal(dir: string, boards: CanvasBoard[]): string {
    return `Build the design in ${canvasProjectDir(dir)} (boards: ${boards.map((b) => boardLabel(b.name)).join(", ")})`;
}

// absolute, because a run's worktree has no copy of the gitignored design folder
export function prototypePath(dir: string, boards: CanvasBoard[]): string {
    return join(dir, "project", boards[0]?.name ?? MAIN_BOARD);
}
