// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Skills tab's matrix, derived from AgentSyncSkillsCommand: managed rows come from the vault,
// unmanaged rows from the adopt plan's per-copy moves, grouped here by name, and link rows from its
// linked list. The keep map holds the user's choice per skill: a runtime whose copy wins, the vault copy
// over a stray one, or leave it alone; adopt turns it into the wire's keep and skip.

import { joinRepoPath } from "@/util/paths";
import type { Tone } from "./setupmodel";

export type SkillKeep = Record<string, string>; // skill name -> runtime, KEEP_VAULT or KEEP_LEAVE

// mirrors wshrpc.AgentSyncKeepVault: replace a vault skill's stray copies with the vault copy
export const KEEP_VAULT = "vault";
// the in-map "leave it where it is" choice, sent as skip and never as a keep; the colon keeps it apart
// from any runtime name
export const KEEP_LEAVE = ":leave";

export type SkillGroupKind = "decide" | "differs" | "same" | "only" | "stray" | "linked" | "managed";

export interface SkillCell {
    runtime: string;
    label: string;
    tone: Tone | null; // null draws no dot: nothing is there
    title?: string;
}

export interface SkillCopy {
    runtime: string;
    label: string;
    path: string;
    seed: boolean;
    vault: boolean; // compared against the vault copy, not a base copy
    keys: string[];
    files: string[];
    bodydiff: boolean;
}

export interface SkillLinkEntry {
    runtime: string;
    label: string;
    path: string;
    target: string;
}

export interface SkillRow {
    name: string;
    kind: SkillGroupKind;
    description: string;
    // unresolved and unmanaged: the rail offers the copy radios
    needsKeep: boolean;
    left: boolean; // the user chose to leave it where it is
    copies: SkillCopy[]; // unmanaged or stray copies in column order; empty for a managed skill
    links: SkillLinkEntry[]; // a linked row's links, in column order
    deltas: Record<string, string[]>; // managed only: what each harness overrides
    cells: SkillCell[];
}

export interface SkillGroup {
    key: string;
    kind: SkillGroupKind;
    title: string;
    rows: SkillRow[];
}

const SKILL_FILE = "SKILL.md";
const NOTHING: Omit<SkillCell, "runtime"> = { label: "—", tone: null };
const REPLACED: Omit<SkillCell, "runtime"> = {
    label: "Replaced",
    tone: "warn",
    title: "Set aside under skills-replaced when Arc manages it",
};

type SkillsData = Pick<
    CommandAgentSyncSkillsRtnData,
    "skills" | "columns" | "skillsroot" | "unmanaged" | "unresolved" | "linked"
>;

function labelOf(columns: AgentSyncSkillColumn[], runtime: string): string {
    return columns.find((c) => c.runtime === runtime)?.label ?? runtime;
}

function canonicalNames(data: SkillsData): Set<string> {
    return new Set((data.skills ?? []).map((s) => s.name));
}

function columnOrder(data: SkillsData): (runtime: string) => number {
    const order = new Map((data.columns ?? []).map((c, i) => [c.runtime, i]));
    return (runtime) => order.get(runtime) ?? 0;
}

// a junction reads back with the NT \??\ prefix, which is no part of the path a person knows
function linkTarget(target: string): string {
    return target.replace(/^\\\?\?\\/, "");
}

// copies of each skill Arc does not own yet, keyed by name, each list in column order
function unmanagedByName(data: SkillsData): Map<string, SkillCopy[]> {
    const order = columnOrder(data);
    const out = new Map<string, SkillCopy[]>();
    for (const m of data.unmanaged ?? []) {
        const copies = out.get(m.name) ?? [];
        copies.push({
            runtime: m.runtime,
            label: labelOf(data.columns ?? [], m.runtime),
            path: m.from,
            seed: m.seed,
            vault: m.vault === true,
            keys: m.keys ?? [],
            files: m.files ?? [],
            bodydiff: m.bodydiff,
        });
        out.set(m.name, copies);
    }
    for (const copies of out.values()) {
        copies.sort((a, b) => order(a.runtime) - order(b.runtime));
    }
    return out;
}

function linksByName(data: SkillsData): Map<string, SkillLinkEntry[]> {
    const order = columnOrder(data);
    const out = new Map<string, SkillLinkEntry[]>();
    for (const l of data.linked ?? []) {
        const links = out.get(l.name) ?? [];
        links.push({
            runtime: l.runtime,
            label: labelOf(data.columns ?? [], l.runtime),
            path: l.path,
            target: linkTarget(l.target),
        });
        out.set(l.name, links);
    }
    for (const links of out.values()) {
        links.sort((a, b) => order(a.runtime) - order(b.runtime));
    }
    return out;
}

function hasDelta(c: SkillCopy): boolean {
    return c.bodydiff || c.keys.length > 0 || c.files.length > 0;
}

function overrides(c: Pick<SkillCopy, "keys" | "files">): string {
    return [...c.keys, ...c.files].join(", ");
}

// a keep counts only when it names a runtime holding a copy; a stale one from before a refetch does not
function validKeep(keep: SkillKeep, name: string, copies: SkillCopy[]): string | null {
    const runtime = keep[name];
    return runtime != null && copies.some((c) => c.runtime === runtime) ? runtime : null;
}

function linkCell(link: SkillLinkEntry): SkillCell {
    return { runtime: link.runtime, label: "Link", tone: "none", title: link.target };
}

function managedCell(skill: AgentSyncSkill, col: AgentSyncSkillColumn, replaced: boolean): SkillCell {
    const state = col.present ? skill.states?.[col.runtime] : "absent";
    const over = skill.deltas?.[col.runtime] ?? [];
    const title = over.length > 0 ? `Overrides ${over.join(", ")}` : undefined;
    switch (state) {
        case "synced":
            return { runtime: col.runtime, label: "Synced", tone: "ok", title };
        case "differs":
            return { runtime: col.runtime, label: "Not synced", tone: "warn", title };
        case "unmanaged":
            return replaced
                ? { runtime: col.runtime, ...REPLACED }
                : { runtime: col.runtime, label: "Own copy", tone: "none" };
        case "linked":
            // the wire lists no target for a vault skill's link, so the title says what Arc does with it
            return {
                runtime: col.runtime,
                label: "Link",
                tone: "warn",
                title: "A link to another folder: Arc leaves it alone and does not write this skill here",
            };
        case "plugin":
            return {
                runtime: col.runtime,
                label: "Plugin",
                tone: "ok",
                title: `Loaded as arc:${skill.name} from the Arc plugin`,
            };
    }
    return { runtime: col.runtime, ...NOTHING };
}

function unmanagedCell(
    copies: SkillCopy[],
    links: SkillLinkEntry[],
    kept: string | null,
    left: boolean,
    runtime: string
): SkillCell {
    const c = copies.find((x) => x.runtime === runtime);
    if (c == null) {
        const link = links.find((l) => l.runtime === runtime);
        return link != null ? linkCell(link) : { runtime, ...NOTHING };
    }
    if (left) {
        return { runtime, label: "Left alone", tone: "none" };
    }
    if (kept != null) {
        return kept === runtime ? { runtime, label: "Kept", tone: "ok" } : { runtime, ...REPLACED };
    }
    if (c.bodydiff) {
        return { runtime, label: "Body differs", tone: "warn" };
    }
    if (hasDelta(c)) {
        return { runtime, label: overrides(c), tone: "warn", title: `Overrides ${overrides(c)}` };
    }
    if (copies.length === 1) {
        return { runtime, label: "Only here", tone: "none" };
    }
    // the base copy every other copy was compared against: it differs when any of them does
    return copies.some(hasDelta)
        ? { runtime, label: "Differs", tone: "warn" }
        : { runtime, label: "Own copy", tone: "none" };
}

function unmanagedKind(copies: SkillCopy[], needsKeep: boolean, decided: boolean): SkillGroupKind {
    if (needsKeep && !decided) {
        return "decide";
    }
    if (copies.length === 1) {
        return "only";
    }
    return copies.some(hasDelta) ? "differs" : "same";
}

export function skillRows(data: SkillsData, keep: SkillKeep): SkillRow[] {
    const columns = data.columns ?? [];
    const canonical = canonicalNames(data);
    const unresolved = new Set(data.unresolved ?? []);
    const unmanaged = unmanagedByName(data);
    const links = linksByName(data);
    const rows: SkillRow[] = (data.skills ?? []).map((s) => {
        // a vault skill's stray copies stay on its one row, as cells and in the rail
        const copies = unmanaged.get(s.name) ?? [];
        const replaced = copies.length > 0 && keep[s.name] === KEEP_VAULT;
        return {
            name: s.name,
            kind: copies.length > 0 ? "stray" : "managed",
            description: s.description ?? "",
            needsKeep: false,
            left: false,
            copies,
            links: [],
            deltas: s.deltas ?? {},
            cells: columns.map((col) => managedCell(s, col, replaced)),
        };
    });
    for (const [name, copies] of unmanaged) {
        if (canonical.has(name)) {
            continue;
        }
        const needsKeep = unresolved.has(name);
        const kept = validKeep(keep, name, copies);
        const left = keep[name] === KEEP_LEAVE;
        const nameLinks = links.get(name) ?? [];
        rows.push({
            name,
            kind: unmanagedKind(copies, needsKeep, kept != null || left),
            description: "",
            needsKeep,
            left,
            copies,
            links: [],
            deltas: {},
            cells: columns.map((col) => unmanagedCell(copies, nameLinks, kept, left, col.runtime)),
        });
    }
    for (const [name, nameLinks] of links) {
        // a link beside a copy of the same name shows as that row's Link cell
        if (canonical.has(name) || unmanaged.has(name)) {
            continue;
        }
        rows.push({
            name,
            kind: "linked",
            description: "",
            needsKeep: false,
            left: false,
            copies: [],
            links: nameLinks,
            deltas: {},
            cells: columns.map((col) => {
                const link = nameLinks.find((l) => l.runtime === col.runtime);
                return link != null ? linkCell(link) : { runtime: col.runtime, ...NOTHING };
            }),
        });
    }
    return rows;
}

const KIND_ORDER: SkillGroupKind[] = ["decide", "differs", "same", "only", "stray", "linked", "managed"];

function groupKey(row: SkillRow): string {
    if (row.kind === "same") {
        return `same:${row.copies.length}`;
    }
    if (row.kind === "only") {
        return `only:${row.copies[0].runtime}`;
    }
    return row.kind;
}

function groupTitle(row: SkillRow): string {
    switch (row.kind) {
        case "decide":
            return "Needs a decision";
        case "differs":
            return "Differs between harnesses";
        case "same":
            return `Same copy in ${row.copies.length} harnesses`;
        case "only":
            return `Only in ${row.copies[0].label}`;
        case "stray":
            return "Own copy beside the vault";
        case "linked":
            return "Linked from another folder";
        case "managed":
            return "Managed by Arc";
    }
}

// Groups in the spec's order; "same" groups run widest first, "only" groups in column order.
export function skillGroups(data: SkillsData, keep: SkillKeep): SkillGroup[] {
    const order = columnOrder(data);
    const groups = new Map<string, SkillGroup>();
    for (const row of skillRows(data, keep)) {
        const key = groupKey(row);
        const g = groups.get(key) ?? { key, kind: row.kind, title: groupTitle(row), rows: [] };
        g.rows.push(row);
        groups.set(key, g);
    }
    const rank = (g: SkillGroup): number[] => {
        const kind = KIND_ORDER.indexOf(g.kind);
        const first = g.rows[0];
        if (g.kind === "same") {
            return [kind, -first.copies.length];
        }
        if (g.kind === "only") {
            return [kind, order(first.copies[0].runtime)];
        }
        return [kind, 0];
    };
    const out = [...groups.values()];
    for (const g of out) {
        g.rows.sort((a, b) => a.name.localeCompare(b.name));
    }
    return out.sort((a, b) => {
        const [ka, sa] = rank(a);
        const [kb, sb] = rank(b);
        return ka - kb || sa - sb;
    });
}

// The keep map sent with adopt: a runtime only for an undecided skill and only one that holds a copy,
// the vault keep only for a vault skill with stray copies, since the backend refuses any other keep and
// moves nothing. A left-alone name goes in adoptSkip instead.
export function adoptKeep(data: SkillsData, keep: SkillKeep): SkillKeep {
    const canonical = canonicalNames(data);
    const byName = unmanagedByName(data);
    const out: SkillKeep = {};
    for (const name of data.unresolved ?? []) {
        const copies = byName.get(name);
        const kept = copies != null && !canonical.has(name) ? validKeep(keep, name, copies) : null;
        if (kept != null) {
            out[name] = kept;
        }
    }
    for (const name of canonical) {
        if (byName.has(name) && keep[name] === KEEP_VAULT) {
            out[name] = KEEP_VAULT;
        }
    }
    return out;
}

// Names the user chose to leave where they are: unmanaged skills only, the one kind adopt would move.
export function adoptSkip(data: SkillsData, keep: SkillKeep): string[] {
    const canonical = canonicalNames(data);
    return [...unmanagedByName(data).keys()].filter((name) => !canonical.has(name) && keep[name] === KEEP_LEAVE).sort();
}

// Skills an adopt would move: every unmanaged name less the skipped and undecided ones, plus each vault
// skill whose stray copies are to be replaced.
export function adoptCount(data: SkillsData, keep: SkillKeep): number {
    const canonical = canonicalNames(data);
    const unresolved = new Set(data.unresolved ?? []);
    const decided = adoptKeep(data, keep);
    let n = 0;
    for (const name of unmanagedByName(data).keys()) {
        if (canonical.has(name)) {
            n += decided[name] === KEEP_VAULT ? 1 : 0;
        } else if (keep[name] !== KEEP_LEAVE && (!unresolved.has(name) || decided[name] != null)) {
            n++;
        }
    }
    return n;
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// The toast after Manage, counted from the adopt reply: what moved, what waits, what was skipped.
export function adoptResultText(rtn: CommandAgentSyncAdoptRtnData, sent: { skip: string[]; keep?: SkillKeep }): string {
    const unresolved = new Set(rtn.unresolved ?? []);
    const moved = new Set(
        (rtn.moves ?? [])
            .filter((m) => !unresolved.has(m.name) && (!m.vault || sent.keep?.[m.name] === KEEP_VAULT))
            .map((m) => m.name)
    );
    if (rtn.dryrun) {
        return `Snapshot: nothing moved (would move ${moved.size})`;
    }
    const parts = [`Moved ${plural(moved.size, "skill")} into the vault`];
    if (unresolved.size > 0) {
        parts.push(`${unresolved.size} wait for a decision`);
    }
    if (sent.skip.length > 0) {
        parts.push(`${sent.skip.length} left alone`);
    }
    return parts.join(" · ");
}

// "19 skills · none managed by Arc"
export function skillsSummary(data: SkillsData): string {
    const canonical = canonicalNames(data);
    const unmanagedOnly = [...unmanagedByName(data).keys()].filter((n) => !canonical.has(n)).length;
    const managed = canonical.size === 0 ? "none" : String(canonical.size);
    return `${plural(canonical.size + unmanagedOnly, "skill")} · ${managed} managed by Arc`;
}

export function manageLabel(n: number): string {
    return `Manage ${plural(n, "skill")} in Arc`;
}

// The header's Pi line: how pi reaches the synced skills, in the tone the backend gave it.
export function piSkillsLine(status: CommandAgentSyncStatusRtnData | null): { text: string; tone: Tone } | null {
    const pi = status?.harnesses?.find((h) => h.runtime === "pi");
    if (pi == null || !pi.present || !pi.note) {
        return null;
    }
    return { text: `Pi skills: ${pi.note}`, tone: pi.notetone === "warn" ? "warn" : "ok" };
}

// The SKILL.md that Preview shows: the vault copy once Arc owns it, a link's own folder, else the kept
// copy, else the base copy.
export function skillFilePath(row: SkillRow, skillsroot: string, keep: SkillKeep): string {
    if (row.kind === "managed" || row.kind === "stray") {
        return joinRepoPath(skillsroot, `${row.name}/${SKILL_FILE}`);
    }
    if (row.kind === "linked") {
        return joinRepoPath(row.links[0].path, SKILL_FILE);
    }
    const kept = validKeep(keep, row.name, row.copies);
    const copy = row.copies.find((c) => c.runtime === kept) ?? row.copies.find((c) => c.seed) ?? row.copies[0];
    return joinRepoPath(copy.path, SKILL_FILE);
}

// What one copy carries against the base copy (or the vault copy), for the rail's "What differs" list.
export function copyDelta(c: SkillCopy): string {
    if (c.bodydiff) {
        return "Body text differs";
    }
    if (hasDelta(c)) {
        return `Overrides ${overrides(c)}`;
    }
    if (c.vault) {
        return "Same as the vault copy";
    }
    return c.seed ? "Base copy" : "Same as the base copy";
}

// "Claude Code and Codex", from the columns that are set up
function presentNames(columns: AgentSyncSkillColumn[]): string[] {
    return columns.filter((c) => c.present).map((c) => c.label);
}

function joinNames(names: string[]): string {
    if (names.length === 0) {
        return "each harness once it is set up";
    }
    return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// "Claude Code and Codex get"
function namesGet(columns: AgentSyncSkillColumn[]): string {
    const names = presentNames(columns);
    return `${joinNames(names)} ${names.length === 1 ? "gets" : "get"}`;
}

export function keepHint(columns: AgentSyncSkillColumn[]): string {
    return `${namesGet(columns)} it. The other copies are set aside.`;
}

export function skillNote(row: SkillRow, columns: AgentSyncSkillColumn[]): string {
    const all = joinNames(presentNames(columns));
    switch (row.kind) {
        case "decide":
            return `The copies differ in body text, so Arc will not pick one for you. Choose the copy ${namesGet(columns)}, or leave them alone.`;
        case "differs":
            return row.needsKeep
                ? `The kept copy becomes the one ${namesGet(columns)}. The others are set aside under skills-replaced.`
                : "The copies differ in frontmatter or files. Arc keeps one shared copy and records each harness's differences beside it.";
        case "same":
            return `The same SKILL.md sits in each harness's skills folder, copied by hand. Managing it in Arc keeps one copy in the vault and writes it into ${all}.`;
        case "only": {
            const here = row.copies[0];
            const others = presentNames(columns.filter((c) => c.runtime !== here.runtime));
            return others.length === 0
                ? `Kept in ${here.label}'s skills folder only. Managing it in Arc keeps it in the vault.`
                : `Kept in ${here.label}'s skills folder only. Managing it in Arc also writes it into ${joinNames(others)}.`;
        }
        case "stray":
            return `Arc manages this skill, but ${joinNames(row.copies.map((c) => c.label))} also ${row.copies.length === 1 ? "keeps its own copy" : "keep their own copies"} beside the vault copy. Arc leaves an own copy alone unless you replace it.`;
        case "linked":
            return "A link to a skill kept in another folder. Arc leaves links alone: it never moves one into the vault or writes through it.";
        case "managed":
            return row.description || `One copy in the vault, written into ${all}.`;
    }
}
