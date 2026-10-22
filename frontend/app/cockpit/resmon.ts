// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Resource Manager's pure model: formatting, ordering, the confirm and outcome texts, and the popover's
// cursor/expand/confirm reducer. resmonstore.ts feeds it the snapshot; the readout and popover only render it.

const UNAVAILABLE = "–";
const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;
const MB_LIMIT = 1000;
const ARC_KEY = "arc";

export function fmtCpu(pct: number, digits: 0 | 1 = 1): string {
    if (pct < 0) {
        return UNAVAILABLE;
    }
    return `${pct.toFixed(digits)}%`;
}

// binary units, as Task Manager shows them
export function fmtMem(bytes: number): string {
    if (bytes < 0) {
        return UNAVAILABLE;
    }
    const mb = Math.round(bytes / MIB);
    if (mb < MB_LIMIT) {
        return `${mb} MB`;
    }
    return `${(bytes / GIB).toFixed(1)} GB`;
}

// fmtMem with the small sizes it rounds away: a folder of 8 KB must not read "0 MB"
export function fmtSize(bytes: number): string {
    if (bytes < 0 || bytes >= MIB) {
        return fmtMem(bytes);
    }
    if (bytes < KIB) {
        return `${Math.round(bytes)} B`;
    }
    return `${Math.round(bytes / KIB)} KB`;
}

export function fmtAge(createTs: number, now: number): string {
    if (createTs <= 0) {
        return UNAVAILABLE;
    }
    const s = Math.max(0, Math.floor((now - createTs) / 1000));
    if (s < 60) {
        return `${s}s`;
    }
    const m = Math.floor(s / 60);
    if (m < 60) {
        return `${m}m`;
    }
    const h = Math.floor(m / 60);
    if (h < 24) {
        return `${h}h ${m % 60}m`;
    }
    return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function busyWords(s: ResMonSnapshotData): string | null {
    if (s.busycpu && s.busymem) {
        return "high CPU and memory";
    }
    if (s.busycpu) {
        return "high CPU";
    }
    if (s.busymem) {
        return "high memory";
    }
    return null;
}

export function readout(s: ResMonSnapshotData | null): {
    visible: boolean;
    ready: boolean;
    cpu: string;
    mem: string;
    busy: string | null;
    aria: string;
} {
    const visible = s == null || s.supported;
    if (s == null || !s.ready) {
        return {
            visible,
            ready: false,
            cpu: UNAVAILABLE,
            mem: UNAVAILABLE,
            busy: null,
            aria: "Resource Manager: reading processes",
        };
    }
    const cpu = fmtCpu(s.cpu, 0);
    const mem = fmtMem(s.mem);
    const busy = busyWords(s);
    const aria = `Resource Manager: Arc and its agents use ${cpu} CPU and ${mem}` + (busy ? `, ${busy}` : "");
    return { visible, ready: true, cpu, mem, busy, aria };
}

// one member of a view: a backend group (one job owner) with its core processes folded into one line
export interface ResMonMember {
    g: ResMonGroup; // the kill owner; confirms and notes are keyed by g.key
    role: string; // "Lead", "Task 2", "Task 2 Verify"; a tab's "Agent" or "Shell"
    head: ProcessInfo | null; // the core row the member's line stands for: the agent, else the shell
    folded: ProcessInfo[]; // the other core rows (launcher, console, agentctl), counted in the member's line
    kids: ProcessInfo[]; // what the member started, depth from 0 under the core
}

// what the popover draws as one collapsible block: Arc, one orchestrator run, or one tab
export interface ResMonView {
    key: string;
    kind: "arc" | "run" | "tab";
    label: string;
    runtime?: string;
    cpu: number;
    mem: number;
    procs: number;
    arcRows: ProcessInfo[];
    members: ResMonMember[];
}

const RUN_KINDS = new Set(["runworker", "runcmd"]);
const ROLE_AGENT = "Agent";
const ROLE_SHELL = "Shell";

// re-roots the untagged rows under the core: each one's depth counts from its nearest core ancestor
function startedRows(rows: ProcessInfo[]): ProcessInfo[] {
    const out: ProcessInfo[] = [];
    const path: ProcessInfo[] = [];
    for (const r of rows) {
        while (path.length > 0 && path[path.length - 1].depth >= r.depth) {
            path.pop();
        }
        path.push(r);
        if (r.tag) {
            continue;
        }
        const core = [...path].reverse().find((p) => p.tag);
        out.push({ ...r, depth: core ? r.depth - core.depth - 1 : r.depth });
    }
    return out;
}

export function memberOf(g: ResMonGroup): ResMonMember {
    const core = g.rows.filter((r) => r.tag);
    const head = core.find((r) => r.tag === "agent") ?? core.find((r) => r.tag === "shell") ?? null;
    return {
        g,
        role: g.role || (g.runtime ? ROLE_AGENT : ROLE_SHELL),
        head,
        folded: core.filter((r) => r !== head),
        kids: startedRows(g.rows),
    };
}

function startedAt(m: ResMonMember): number {
    return m.g.rows[0]?.createts ?? 0;
}

// Arc first however low its CPU, then by CPU, ties by label; a run's members in the order they started
export function buildViews(groups: ResMonGroup[]): ResMonView[] {
    const views = new Map<string, ResMonView>();
    for (const g of groups) {
        const run = RUN_KINDS.has(g.ownerkind);
        const key = run ? `run:${g.runid || g.key}` : g.key;
        let v = views.get(key);
        if (v == null) {
            const kind = g.key === ARC_KEY ? "arc" : run ? "run" : "tab";
            v = { key, kind, label: g.label, runtime: g.runtime, cpu: 0, mem: 0, procs: 0, arcRows: [], members: [] };
            views.set(key, v);
        }
        v.cpu += g.cpu;
        v.mem += g.mem;
        v.procs += g.rows.length;
        if (v.kind === "arc") {
            v.arcRows = g.rows;
        } else {
            v.members.push(memberOf(g));
        }
    }
    for (const v of views.values()) {
        v.members.sort((a, b) => startedAt(a) - startedAt(b) || a.role.localeCompare(b.role));
    }
    return [...views.values()].sort((a, b) => {
        if ((a.kind === "arc") !== (b.kind === "arc")) {
            return a.kind === "arc" ? -1 : 1;
        }
        return b.cpu - a.cpu || a.label.localeCompare(b.label);
    });
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// the popover's subtitle: what is running, not the backend's owner count
export function viewsSummary(views: ResMonView[]): string {
    const runs = views.filter((v) => v.kind === "run").length;
    const tabs = views.filter((v) => v.kind === "tab").length;
    const parts = [runs > 0 && plural(runs, "run"), tabs > 0 && plural(tabs, "agent tab")].filter(Boolean);
    return [...parts, processes(views.reduce((n, v) => n + v.procs, 0))].join(" · ");
}

const KIND_WORDS: Record<string, string> = {
    arc: "App, read-only",
    agenttab: "Agent tab",
    runworker: "Run worker",
    runcmd: "Run command, read-only",
};

const KIND_NOUNS: Record<string, string> = {
    arc: "Arc",
    agenttab: "agent tab",
    runworker: "run worker",
    runcmd: "run command",
};

// a tab's label is its tab name, which is the project for every tab launched in one, so the Agent tree's name
// for it (custom name, else the agent's ai-title) leads and the project moves to the detail. A run is titled by
// its run title and counts its agents and plan commands.
export function viewHeader(v: ResMonView, treeName: string | undefined): { title: string; detail: string } {
    const procs = processes(v.procs);
    if (v.kind === "arc") {
        return { title: v.label, detail: `${ownerKindWords("arc")} · ${procs}` };
    }
    if (v.kind === "run") {
        const cmds = v.members.filter((m) => m.g.ownerkind === "runcmd").length;
        const agents = v.members.length - cmds;
        const parts = [agents > 0 && plural(agents, "agent"), cmds > 0 && plural(cmds, "command")].filter(Boolean);
        return { title: v.label, detail: ["Run", ...parts, procs].join(" · ") };
    }
    const name = treeName?.trim();
    if (!name) {
        return { title: v.label, detail: procs };
    }
    const project = v.label && !name.includes(v.label) ? `${v.label} · ` : "";
    return { title: name, detail: project + procs };
}

export function ownerKindWords(kind: string): string {
    return KIND_WORDS[kind] ?? kind;
}

export function ownerNoun(kind: string): string {
    return KIND_NOUNS[kind] ?? kind;
}

// splits a command line into its executable token and the rest; a quoted executable keeps its spaces
function splitCommand(command: string): { exe: string; args: string } {
    const c = command.trim();
    const end = c.startsWith('"') ? c.indexOf('"', 1) : c.search(/\s/);
    if (end < 0) {
        return { exe: c.replace(/^"/, ""), args: "" };
    }
    const exe = c.startsWith('"') ? c.slice(1, end) : c.slice(0, end);
    return { exe, args: c.slice(end + 1).trim() };
}

function baseName(path: string): string {
    return path.split(/[\\/]/).pop() ?? path;
}

export function rowLabel(row: ProcessInfo): { name: string; cmd: string } {
    const { exe, args } = splitCommand(row.command ?? "");
    const image = row.name || baseName(exe);
    if (row.role) {
        const type = (row.command ?? "").match(/--type=\S+/)?.[0];
        return { name: row.role, cmd: type ? `${image} ${type}` : image };
    }
    return { name: image || `pid ${row.pid}`, cmd: args };
}

// a member line's command: an agent by its runtime, a shell or plan command by its command line
export function memberCommand(m: ResMonMember): string {
    if (m.head == null) {
        return "";
    }
    if (m.g.runtime) {
        return m.g.runtime;
    }
    const { name, cmd } = rowLabel(m.head);
    return cmd ? `${name} ${cmd}` : name;
}

export function foldedTitle(m: ResMonMember): string {
    return "Also in this line: " + m.folded.map((r) => `${rowLabel(r).name} (${r.tag})`).join(", ");
}

export function subtreeSize(rows: ProcessInfo[], index: number): number {
    let n = 0;
    for (let j = index + 1; j < rows.length && rows[j].depth > rows[index].depth; j++) {
        n++;
    }
    return n;
}

function processes(n: number): string {
    return `${n} process${n === 1 ? "" : "es"}`;
}

function childProcesses(n: number): string {
    return `${n} child ${n === 1 ? "process" : "processes"}`;
}

export function killConfirmText(row: ProcessInfo, children: number): string {
    const who = `${rowLabel(row).name} (${row.pid})`;
    if (children === 0) {
        return `Kill ${who}? It has no child processes.`;
    }
    return `Kill ${who} and its ${childProcesses(children)}?`;
}

export function killChildrenTargets(g: ResMonGroup): ProcessInfo[] {
    return g.rows.filter((r) => !r.tag);
}

export function killChildrenConfirmText(g: ResMonGroup, owner: string = g.label): string {
    const ask = `Kill ${processes(killChildrenTargets(g).length)} under ${owner}?`;
    const survivor = g.rows.find((r) => r.tag === "agent") ?? g.rows.find((r) => r.tag === "shell");
    if (survivor == null) {
        return ask;
    }
    const name = rowLabel(survivor).name;
    const keeps = g.rows.some((r) => r.tag === "console")
        ? `${name} and its console keep running.`
        : `${name} keeps running.`;
    return `${ask} ${keeps}`;
}

export function outcomeNote(
    r: ResMonKillRtnData,
    target: { name: string; pid: number } | null,
    g: ResMonGroup
): { text: string; tone: "note" | "alert" } {
    const who = target ? `${target.name} (${target.pid})` : null;
    switch (r.outcome) {
        case "killed": {
            if (who == null) {
                return { text: `Killed ${processes(r.killed)}.`, tone: "note" };
            }
            const children = r.killed - 1;
            return {
                text: children > 0 ? `Killed ${who} and ${childProcesses(children)}.` : `Killed ${who}.`,
                tone: "note",
            };
        }
        case "gone":
            return { text: `${who ?? "The processes"} had already exited.`, tone: "note" };
        case "refused": {
            const what = target ? `pid ${target.pid} no longer belongs` : "these processes no longer belong";
            return {
                text: `Not killed: ${what} to this ${ownerNoun(g.ownerkind)}. The list refreshes in 2s.`,
                tone: "alert",
            };
        }
        case "protected":
            return {
                text: `Not killed: ${who ?? "that"} is the agent's own process. Kill children stops what it started.`,
                tone: "alert",
            };
        default: {
            const err = (r.error ?? "").trim().replace(/\.+$/, "");
            const still = who ? "It is still running." : "They are still running.";
            return {
                text: `Could not kill ${who ?? "the processes"}${err ? `: ${err}` : ""}. ${still}`,
                tone: "alert",
            };
        }
    }
}

export interface ResMonUi {
    cursor: string | null; // a ResMonLine id
    expanded: Record<string, boolean>; // view keys toggled from their default; see isExpanded
    confirm: { kind: "row"; key: string; pid: number } | { kind: "group"; key: string } | null; // key: a group key
    notes: Record<string, { text: string; tone: "note" | "alert" }>; // by group key
}

// views is the order the popover draws (buildViews); at moves the cursor there first, for a click
export type ResMonAction =
    | { type: "move"; delta: 1 | -1; views: ResMonView[] }
    | { type: "toggle"; views: ResMonView[]; key?: string } // undefined = the cursor's view
    | { type: "askKill"; views: ResMonView[]; at?: string } // x: a cursor on a row an agent started
    | { type: "askChildren"; views: ResMonView[]; at?: string } // ⇧X: the cursor's member, when it is killable and started any
    | { type: "cancel" }
    | { type: "note"; key: string; note: { text: string; tone: "note" | "alert" } }
    | { type: "close" }; // clears confirm, notes and cursor; keeps expanded

export const RESMON_UI_INITIAL: ResMonUi = { cursor: null, expanded: {}, confirm: null, notes: {} };

// every view starts collapsed, so the popover opens as a one-line-per-view summary
export function isExpanded(ui: ResMonUi, key: string): boolean {
    return ui.expanded[key] ?? false;
}

// one line the cursor can sit on. A view's header; a member's line; a process row, with the member it belongs
// to (none in Arc) and its index in the list its subtree is counted in
export type ResMonLine =
    | { id: string; kind: "view"; view: ResMonView }
    | { id: string; kind: "member"; view: ResMonView; m: ResMonMember }
    | { id: string; kind: "proc"; view: ResMonView; m: ResMonMember | null; row: ProcessInfo; index: number };

export const memberLineId = (g: ResMonGroup): string => `m:${g.key}`;
export const procLineId = (owner: string, pid: number): string => `${owner}/${pid}`;

function viewLines(v: ResMonView, open: boolean): ResMonLine[] {
    const out: ResMonLine[] = [{ id: v.key, kind: "view", view: v }];
    if (!open) {
        return out;
    }
    v.arcRows.forEach((row, index) =>
        out.push({ id: procLineId(v.key, row.pid), kind: "proc", view: v, m: null, row, index })
    );
    for (const m of v.members) {
        out.push({ id: memberLineId(m.g), kind: "member", view: v, m });
        m.kids.forEach((row, index) =>
            out.push({ id: procLineId(m.g.key, row.pid), kind: "proc", view: v, m, row, index })
        );
    }
    return out;
}

export function resmonLines(views: ResMonView[], ui: ResMonUi): ResMonLine[] {
    return views.flatMap((v) => viewLines(v, isExpanded(ui, v.key)));
}

// a line whatever its view's expansion: a click can name a line the keyboard cursor could not reach
function findLine(views: ResMonView[], id: string | null): ResMonLine | null {
    if (id == null) {
        return null;
    }
    return views.flatMap((v) => viewLines(v, true)).find((l) => l.id === id) ?? null;
}

function move(ui: ResMonUi, delta: 1 | -1, views: ResMonView[]): ResMonUi {
    const ids = resmonLines(views, ui).map((l) => l.id);
    if (ids.length === 0) {
        return ui;
    }
    const at = ui.cursor == null ? -1 : ids.indexOf(ui.cursor);
    const next = at < 0 ? (delta === 1 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, at + delta));
    return { ...ui, cursor: ids[next] };
}

function toggle(ui: ResMonUi, views: ResMonView[], key: string | undefined): ResMonUi {
    const cursorView = findLine(views, ui.cursor)?.view.key;
    const k = key ?? cursorView;
    if (k == null) {
        return ui;
    }
    const open = !isExpanded(ui, k);
    // collapsing hides the cursor's line, so the cursor falls back to its view's header
    const cursor = !open && cursorView === k ? k : ui.cursor;
    return { ...ui, cursor, expanded: { ...ui.expanded, [k]: open } };
}

function withoutNote(notes: ResMonUi["notes"], key: string): ResMonUi["notes"] {
    const { [key]: _, ...rest } = notes;
    return rest;
}

function askKill(ui: ResMonUi, views: ResMonView[], at: string | undefined): ResMonUi {
    const cursor = at ?? ui.cursor;
    const l = findLine(views, cursor);
    if (l?.kind !== "proc" || l.m == null || !l.m.g.killable || l.row.tag) {
        return ui;
    }
    const key = l.m.g.key;
    return { ...ui, cursor, confirm: { kind: "row", key, pid: l.row.pid }, notes: withoutNote(ui.notes, key) };
}

// a member's line or one of its rows names the member; a tab's header names its only one. A run's header names
// none: a kill across every worker of a run is too easy to send by mistake
function lineMember(l: ResMonLine | null): ResMonMember | null {
    if (l == null) {
        return null;
    }
    if (l.kind === "view") {
        return l.view.kind === "tab" && l.view.members.length === 1 ? l.view.members[0] : null;
    }
    return l.m;
}

function askChildren(ui: ResMonUi, views: ResMonView[], at: string | undefined): ResMonUi {
    const cursor = at ?? ui.cursor;
    const l = findLine(views, cursor);
    const m = lineMember(l);
    if (l == null || m == null || !m.g.killable || m.kids.length === 0) {
        return ui;
    }
    // asked from a collapsed tab's header, the confirm sits under the member's line, so the view opens to show it
    return {
        ...ui,
        cursor,
        expanded: { ...ui.expanded, [l.view.key]: true },
        confirm: { kind: "group", key: m.g.key },
        notes: withoutNote(ui.notes, m.g.key),
    };
}

export function resmonReduce(ui: ResMonUi, a: ResMonAction): ResMonUi {
    switch (a.type) {
        case "move":
            return move(ui, a.delta, a.views);
        case "toggle":
            return toggle(ui, a.views, a.key);
        case "askKill":
            return askKill(ui, a.views, a.at);
        case "askChildren":
            return askChildren(ui, a.views, a.at);
        case "cancel":
            return { ...ui, confirm: null };
        case "note":
            return { ...ui, notes: { ...ui.notes, [a.key]: a.note } };
        case "close":
            return { ...RESMON_UI_INITIAL, expanded: ui.expanded };
    }
}
