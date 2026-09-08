// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Vault's detail rail (Wave-vault-tab.dc.html). Four modes, chosen by what you last touched:
// triage context while the cursor is in the review queue, the saved-note detail once you select a
// note, the harness list on the steering collection, and one skill on the skills collection. The
// dry-run plan card sits above whichever mode is showing, because a sync is a whole-vault action.

import { CollapsibleRail, type RailSection } from "@/app/element/collapsiblerail";
import { MOTION } from "@/app/element/motiontokens";
import { globalStore } from "@/app/store/jotaiStore";
import { AskJarvisButton, sourceRefForMemory } from "@/app/view/jarvis/contextualentry";
import { cn, fireAndForget } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import type { AgentsViewModel } from "./agents";
import { AmbientTags, RelevantDecisions } from "./ambientviews";
import { MarkdownMessage } from "./markdownmessage";
import {
    confirmDeleteNote,
    keepPending,
    memBodyAtom,
    memConflictAtom,
    memDraftAtom,
    memEdgesAtom,
    memEditingAtom,
    memNotesAtom,
    memPendingAtom,
    memRailOpenAtom,
    memSelectedIdAtom,
    saveNote,
    selectNote,
} from "./memstore";
import { typeMeta, type MemNote } from "./memtypes";
import { RAIL_ICON } from "./railicons";
import {
    adoptSkills,
    applySync,
    closePlan,
    foldIntoShared,
    noteTally,
    selectDocTab,
    vaultCursorAtom,
    vaultDocTabAtom,
    vaultFocusAtom,
    vaultHarnessesAtom,
    vaultPlanAtom,
    vaultReaderAtom,
    vaultScopeAtom,
    vaultSelectedSkillAtom,
    vaultSkillColumnsAtom,
    vaultSkillsAtom,
    vaultSkillsRootAtom,
    vaultStatusAtom,
    vaultSyncBusyAtom,
    vaultTabAtom,
} from "./vaultstore";
import { filterQueue, overlapping, sameRun, scopeLabel } from "./vaulttriage";

const HEAD = "font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-mid";

function SectionHead({ children }: { children: React.ReactNode }) {
    return <span className={HEAD}>{children}</span>;
}

function MetaRow({ label, value, title }: { label: string; value: string; title?: string }) {
    return (
        <div className="flex justify-between gap-[10px] border-b border-edge-faint py-[7px]">
            <span className="flex-none text-[12px] text-ink-mid">{label}</span>
            <span title={title} className="min-w-0 truncate font-mono text-[11.5px] text-ink-hi">
                {value}
            </span>
        </div>
    );
}

// ---- the dry-run plan ----

const PLAN_TONE: Record<string, string> = {
    "steering-write": "text-accent-soft",
    "skill-write": "text-accent-soft",
    "skill-remove": "text-ink-mid",
    "skill-unmanaged": "text-warning",
};

function PlanCard() {
    const plan = useAtomValue(vaultPlanAtom);
    const busy = useAtomValue(vaultSyncBusyAtom);
    if (!plan) return null;
    const conflicts = plan.filter((a) => a.kind === "skill-unmanaged").length;
    const writes = plan.length - conflicts;
    return (
        <div className="overflow-hidden rounded-[9px] border border-accent/40 bg-surface-raised">
            <div className="flex items-center gap-[8px] border-b border-edge-faint px-[12px] py-[9px]">
                <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.1em] text-accent-soft">
                    Plan · dry run
                </span>
                <div className="flex-1" />
                <button
                    onClick={closePlan}
                    className="font-mono text-[10px] font-semibold text-ink-mid hover:text-primary"
                >
                    Close
                </button>
            </div>
            <div className="flex max-h-[220px] flex-col gap-[6px] overflow-auto px-[12px] py-[10px]">
                {plan.length === 0 ? (
                    <span className="text-[11.5px] text-ink-mid">Everything is already in sync.</span>
                ) : (
                    plan.map((a, i) => (
                        <div key={`${a.kind}-${a.path}-${i}`} className="flex gap-[8px] font-mono text-[10px]">
                            <span className={cn("min-w-[96px] flex-none", PLAN_TONE[a.kind] ?? "text-ink-mid")}>
                                {a.kind}
                            </span>
                            <span className="break-all text-ink-mid">{a.path}</span>
                        </div>
                    ))
                )}
            </div>
            <div className="flex items-center gap-[8px] border-t border-edge-faint px-[12px] py-[10px]">
                <span className="text-[10.5px] text-ink-mid">
                    {conflicts > 0
                        ? `${conflicts} director${conflicts === 1 ? "y" : "ies"} you maintain stay untouched until adopted.`
                        : "Nothing blocked."}
                </span>
                <div className="flex-1" />
                <button
                    onClick={() => fireAndForget(applySync)}
                    disabled={busy || writes === 0}
                    className="rounded-[6px] bg-accent px-[12px] py-[5px] text-[11px] font-semibold text-background hover:bg-accenthover disabled:opacity-40"
                >
                    {busy ? "Applying…" : `Apply ${writes}`}
                </button>
            </div>
        </div>
    );
}

// ---- mode 1: triage ----

function TriageMode() {
    const pending = useAtomValue(memPendingAtom);
    const notes = useAtomValue(memNotesAtom);
    const cursor = useAtomValue(vaultCursorAtom);
    const scope = useAtomValue(vaultScopeAtom);

    const items = pending.map((p) => ({
        path: p.path,
        scope: p.scope || "shared",
        source: p.source,
        title: p.title,
        body: p.body,
    }));
    const visible = filterQueue(items, scope, "");
    const cur = visible[Math.min(cursor, Math.max(0, visible.length - 1))];
    if (!cur) {
        return <div className="text-[12.5px] text-ink-mid">Queue clear — nothing waiting on review.</div>;
    }
    const overlaps = overlapping(cur.title, notes);
    const run = sameRun(visible, cur);

    return (
        <div className="flex flex-col gap-[18px]">
            <div className="flex flex-col gap-[8px]">
                <SectionHead>Already saved under this title</SectionHead>
                {overlaps.length > 0 ? (
                    overlaps.map((n) => (
                        <button
                            key={n.id}
                            onClick={() => {
                                globalStore.set(vaultFocusAtom, "saved");
                                fireAndForget(() => selectNote(n.id));
                            }}
                            className="flex w-full flex-col gap-[5px] rounded-[9px] border border-accent/40 bg-background px-[12px] py-[10px] text-left hover:bg-surface"
                        >
                            <span className="font-mono text-[12px] font-semibold text-accent-soft">{n.title}</span>
                            <span className="text-[11.5px] leading-[1.5] text-ink-mid">{n.description}</span>
                        </button>
                    ))
                ) : (
                    <div className="rounded-[9px] border border-dashed border-edge-mid px-[12px] py-[10px] text-[11.5px] text-ink-faint">
                        No saved note shares this title.
                    </div>
                )}
            </div>
            {run.length > 0 && (
                <div className="flex flex-col gap-[8px]">
                    <SectionHead>From the same run</SectionHead>
                    {run.map((r) => (
                        <div
                            key={r.path}
                            className="flex min-w-0 items-center gap-[9px] rounded-[8px] border border-edge-faint bg-background px-[10px] py-[8px]"
                        >
                            <span className="h-[5px] w-[5px] flex-none rounded-full bg-asking" />
                            <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-mid">{r.title}</span>
                        </div>
                    ))}
                    <button
                        onClick={() => {
                            const batch = [cur, ...run];
                            noteTally(true, batch.length);
                            globalStore.set(vaultStatusAtom, `Kept ${batch.length} from one run`);
                            fireAndForget(async () => {
                                for (const p of batch) await keepPending(p.path);
                            });
                        }}
                        className="rounded-[7px] border border-success/30 bg-success/15 py-[5px] text-[11.5px] font-semibold text-success hover:bg-success/25"
                    >
                        Keep all {run.length + 1} from {cur.source}
                    </button>
                </div>
            )}
        </div>
    );
}

// ---- mode 2: saved-note detail ----

function NoteMode({ model }: { model: AgentsViewModel }) {
    const notes = useAtomValue(memNotesAtom);
    const edges = useAtomValue(memEdgesAtom);
    const selectedId = useAtomValue(memSelectedIdAtom);
    const body = useAtomValue(memBodyAtom);
    const [editing, setEditing] = useAtom(memEditingAtom);
    const [draft, setDraft] = useAtom(memDraftAtom);
    const [conflict, setConflict] = useAtom(memConflictAtom);

    const sel = notes.find((n) => n.id === selectedId);
    if (!sel) return <div className="text-[12.5px] text-ink-mid">Select a memory to see its content.</div>;

    const relatedIds = new Set<string>();
    for (const e of edges) {
        if (e.from === sel.id) relatedIds.add(e.to);
        if (e.to === sel.id) relatedIds.add(e.from);
    }
    const related: { note: MemNote; dir: string }[] = notes
        .filter((n) => relatedIds.has(n.id))
        .map((n) => ({ note: n, dir: sel.links.includes(n.id) ? "links" : "backlink" }));

    const m = typeMeta(sel.type);
    const doSave = () =>
        fireAndForget(async () => {
            const r = await saveNote(sel.path, draft, body?.mtime ?? 0);
            if (r.conflict) setConflict(true);
            else setEditing(false);
        });

    return (
        <div className="flex flex-col gap-[18px]">
            <div className="flex flex-col gap-[11px]">
                <div className="flex items-center gap-[9px]">
                    <span
                        className={cn(
                            "rounded-[5px] px-[9px] py-[2px] font-mono text-[9.5px] font-semibold uppercase tracking-[0.05em]",
                            m.pillClass,
                            m.tintClass
                        )}
                    >
                        {m.label}
                    </span>
                    <AmbientTags links={sel.links} />
                    <div className="flex-1" />
                    <span title={sel.scope} className="font-mono text-[10.5px] text-ink-faint">
                        {scopeLabel(sel.scope)}
                    </span>
                </div>
                <h2 className="text-[16px] font-bold leading-[1.35] text-primary">{sel.title}</h2>
                <div className="flex items-center gap-[9px]">
                    <SectionHead>Content</SectionHead>
                    <div className="flex-1" />
                    {!editing && (
                        <button
                            onClick={() => globalStore.set(vaultReaderAtom, { kind: "saved", id: sel.id })}
                            className="font-mono text-[10.5px] font-semibold text-accent-soft hover:text-accenthover"
                        >
                            Read full ↗
                        </button>
                    )}
                </div>
                <AnimatePresence mode="wait" initial={false}>
                    <motion.div
                        key={editing ? "edit" : body == null ? "load" : "ready"}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1, transition: { duration: MOTION.durMacro, ease: MOTION.easeFluid } }}
                        exit={{ opacity: 0, transition: { duration: MOTION.durExit, ease: MOTION.easeFluid } }}
                    >
                        {editing ? (
                            <textarea
                                autoFocus
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                                className="h-[220px] w-full resize-none rounded-[10px] border border-accent/40 bg-background px-[13px] py-[11px] font-mono text-[12.5px] leading-[1.6] text-ink-hi outline-none"
                            />
                        ) : (
                            <div className="max-h-[260px] overflow-auto text-[12.5px] leading-[1.65] text-ink-hi">
                                {body == null ? "Loading…" : <MarkdownMessage text={body.body || sel.description} />}
                            </div>
                        )}
                    </motion.div>
                </AnimatePresence>
                {conflict && (
                    <div className="rounded border border-warning/40 bg-warning/10 px-[11px] py-[8px] text-[12px] text-warning">
                        This note changed on disk since you opened it. Reload to see the latest before saving.
                    </div>
                )}
            </div>

            <div className="flex flex-col">
                <MetaRow label="Scope" value={scopeLabel(sel.scope)} title={sel.scope} />
                <MetaRow label="Type" value={sel.type || "note"} />
                <MetaRow label="Source" value={sel.source} />
                <MetaRow label="Updated" value={sel.updatedts ? new Date(sel.updatedts).toLocaleDateString() : "—"} />
                <MetaRow label="Path" value={`…/${sel.id}.md`} title={sel.path} />
            </div>

            <RelevantDecisions links={sel.links} />

            {related.length > 0 && (
                <div className="flex flex-col gap-[8px]">
                    <SectionHead>Related · {related.length}</SectionHead>
                    {related.map(({ note, dir }) => {
                        const rm = typeMeta(note.type);
                        return (
                            <button
                                key={note.id}
                                onClick={() => fireAndForget(() => selectNote(note.id))}
                                className="flex w-full min-w-0 items-center gap-[9px] rounded-[8px] border border-edge-faint bg-background px-[10px] py-[7px] text-left hover:border-edge-strong"
                            >
                                <span className={cn("h-[5px] w-[5px] flex-none rounded-full", rm.dotClass)} />
                                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-mid">
                                    {note.title}
                                </span>
                                <span className="flex-none font-mono text-[9.5px] text-ink-faint">{dir}</span>
                            </button>
                        );
                    })}
                </div>
            )}

            <div className="flex gap-[8px]">
                {editing ? (
                    <>
                        <button
                            onClick={doSave}
                            className="flex-1 rounded-[7px] bg-accent py-[7px] text-[11.5px] font-semibold text-background hover:bg-accenthover"
                        >
                            Save
                        </button>
                        <button
                            onClick={() => {
                                setEditing(false);
                                setConflict(false);
                            }}
                            className="flex-1 rounded-[7px] border border-edge-mid py-[7px] text-[11.5px] font-semibold text-ink-mid hover:border-edge-strong"
                        >
                            Cancel
                        </button>
                        {conflict && (
                            <button
                                onClick={() => fireAndForget(() => selectNote(sel.id))}
                                className="rounded-[7px] border border-edge-mid px-[10px] py-[7px] text-[11.5px] text-ink-mid"
                            >
                                Reload
                            </button>
                        )}
                    </>
                ) : (
                    <>
                        <button
                            onClick={() => {
                                setDraft(body?.body ?? "");
                                setConflict(false);
                                setEditing(true);
                            }}
                            className="flex-1 rounded-[7px] border border-accent/40 bg-accent/15 py-[7px] text-[11.5px] font-semibold text-accent-soft hover:bg-accentbg"
                        >
                            Edit
                        </button>
                        <AskJarvisButton model={model} sourceRef={sourceRefForMemory(sel)} label="Ask Jarvis" />
                        <button
                            title="Delete"
                            onClick={() => confirmDeleteNote(sel.path, sel.title)}
                            className="flex-none rounded-[7px] border border-edge-mid px-[12px] py-[7px] text-[11.5px] font-semibold text-ink-faint hover:border-error/40 hover:text-error"
                        >
                            Delete
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}

// ---- mode 3: harnesses ----

const HARNESS_TONE: Record<string, { dot: string; text: string }> = {
    current: { dot: "bg-success", text: "text-success" },
    stale: { dot: "bg-warning", text: "text-warning" },
    absent: { dot: "bg-muted", text: "text-muted" },
};

const HARNESS_LABEL: Record<string, string> = {
    current: "in sync",
    stale: "out of date",
    absent: "not written",
};

function HarnessMode() {
    const harnesses = useAtomValue(vaultHarnessesAtom);
    const docTab = useAtomValue(vaultDocTabAtom);
    const busy = useAtomValue(vaultSyncBusyAtom);
    const present = harnesses.filter((h) => h.present);
    const current = present.filter((h) => h.steering === "current").length;
    const withOwn = present.filter((h) => h.own);
    return (
        <div className="flex flex-col gap-[18px]">
            <div className="flex flex-col gap-[8px]">
                <SectionHead>
                    Shared doc · {current} of {present.length} in sync
                </SectionHead>
                {harnesses.map((h) => {
                    const state = h.present ? h.steering : "absent";
                    const tone = HARNESS_TONE[state] ?? HARNESS_TONE.absent;
                    return (
                        <button
                            key={h.runtime}
                            onClick={() => selectDocTab(h.runtime)}
                            disabled={!h.present}
                            data-vault-harness-row={h.runtime}
                            className={cn(
                                "flex w-full items-center gap-[9px] rounded-[9px] border px-[11px] py-[9px] text-left",
                                docTab === h.runtime
                                    ? "border-accent/40 bg-accent/15"
                                    : "border-edge-faint bg-background hover:border-edge-strong",
                                !h.present && "opacity-50"
                            )}
                        >
                            <span className={cn("h-[6px] w-[6px] flex-none rounded-full", tone.dot)} />
                            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] font-medium text-ink-hi">
                                {h.label}
                            </span>
                            <span className={cn("font-mono text-[10px]", tone.text)}>
                                {h.present ? (HARNESS_LABEL[state] ?? state) : "not installed"}
                            </span>
                        </button>
                    );
                })}
            </div>
            {withOwn.length > 0 && (
                <div className="flex flex-col gap-[8px] rounded-[9px] border border-warning/30 bg-warning/10 px-[12px] py-[11px]">
                    <span className="text-[11.5px] font-semibold text-warning">
                        {withOwn.length} harness{withOwn.length === 1 ? "" : "es"} still hold rules of their own
                    </span>
                    <span className="text-[11.5px] leading-[1.5] text-ink-mid">
                        Moving them into the shared doc is what makes them apply everywhere. Nothing is cleared from a
                        harness before it lands there.
                    </span>
                    {withOwn.map((h) => (
                        <button
                            key={h.runtime}
                            onClick={() => fireAndForget(() => foldIntoShared(h.runtime))}
                            disabled={busy}
                            className="rounded-[6px] border border-warning/40 py-[6px] text-[11.5px] font-semibold text-warning hover:bg-warning/15 disabled:opacity-40"
                        >
                            {busy ? "Moving…" : `Move ${h.label} into Shared`}
                        </button>
                    ))}
                </div>
            )}
            <div className="flex flex-col">
                <MetaRow label="Direction" value="shared → harness" />
                <MetaRow label="Per-harness" value="edit that harness's tab" />
                <MetaRow label="Skills managed" value={String(harnesses.reduce((n, h) => n + h.skillsmanaged, 0))} />
            </div>
        </div>
    );
}

// ---- mode 4: one skill ----

function SkillMode() {
    const skills = useAtomValue(vaultSkillsAtom);
    const columns = useAtomValue(vaultSkillColumnsAtom);
    const selected = useAtomValue(vaultSelectedSkillAtom);
    const root = useAtomValue(vaultSkillsRootAtom);
    const busy = useAtomValue(vaultSyncBusyAtom);
    const skill = skills.find((s) => s.name === selected);
    if (!skill) return <div className="text-[12.5px] text-ink-mid">Select a skill to see where it goes.</div>;
    const unmanaged = columns.filter((c) => skill.states?.[c.runtime] === "unmanaged");
    const deltas = Object.entries(skill.deltas ?? {});
    const labelFor = (runtime: string) => columns.find((c) => c.runtime === runtime)?.label ?? runtime;
    return (
        <div className="flex flex-col gap-[18px]">
            <div className="flex flex-col gap-[9px]">
                <span className="font-mono text-[13px] font-semibold text-primary">{skill.name}</span>
                <span className="text-[12px] leading-[1.55] text-ink-mid">{skill.description}</span>
                <span className="break-all font-mono text-[10.5px] text-ink-faint">
                    {root}/{skill.name}/SKILL.md
                </span>
            </div>
            {/* the whole reason junctions were dropped: one skill, different in one place per harness */}
            {deltas.length > 0 && (
                <div className="flex flex-col gap-[8px]">
                    <SectionHead>Per-harness differences</SectionHead>
                    {deltas.map(([runtime, items]) => (
                        <div
                            key={runtime}
                            className="flex flex-col gap-[4px] rounded-[8px] border border-edge-faint bg-background px-[11px] py-[9px]"
                        >
                            <span className="font-mono text-[11.5px] font-medium text-ink-hi">{labelFor(runtime)}</span>
                            <span className="font-mono text-[10.5px] leading-[1.6] text-ink-mid">
                                {items.join(", ")}
                            </span>
                        </div>
                    ))}
                </div>
            )}
            {unmanaged.length > 0 ? (
                <div className="flex flex-col gap-[8px] rounded-[9px] border border-warning/30 bg-warning/10 px-[12px] py-[11px]">
                    <span className="text-[11.5px] font-semibold text-warning">
                        {unmanaged.map((c) => c.label).join(", ")} keeps its own copy here
                    </span>
                    <span className="text-[11.5px] leading-[1.5] text-ink-mid">
                        A directory you maintain is never overwritten. Adopting folds it into the vault; a copy that
                        differs only in a frontmatter key or an extra file becomes a per-harness difference rather than
                        a conflict.
                    </span>
                    <button
                        onClick={() => fireAndForget(adoptSkills)}
                        disabled={busy}
                        className="rounded-[6px] bg-accent py-[6px] text-[11.5px] font-semibold text-background hover:bg-accenthover disabled:opacity-40"
                    >
                        {busy ? "Adopting…" : "Adopt into the vault"}
                    </button>
                </div>
            ) : (
                <div className="rounded-[9px] border border-edge-faint bg-background px-[12px] py-[11px] text-[11.5px] leading-[1.5] text-ink-mid">
                    Written from the vault into every harness that scans a skills directory. Deleting it here removes it
                    everywhere on the next sync.
                </div>
            )}
        </div>
    );
}

// ---- the rail ----

export function VaultRail({ model }: { model: AgentsViewModel }) {
    const tab = useAtomValue(vaultTabAtom);
    const focus = useAtomValue(vaultFocusAtom);
    const pending = useAtomValue(memPendingAtom);
    const notes = useAtomValue(memNotesAtom);
    const selectedId = useAtomValue(memSelectedIdAtom);
    const cursor = useAtomValue(vaultCursorAtom);
    const selectedSkill = useAtomValue(vaultSelectedSkillAtom);

    const triage = tab === "memory" && focus === "queue" && pending.length > 0;
    const sel = notes.find((n) => n.id === selectedId);
    const title =
        tab === "steering"
            ? "Harnesses reading this"
            : tab === "skills"
              ? "Skill"
              : triage
                ? "Review context"
                : "Memory detail";
    const meta =
        tab === "steering"
            ? "vault → harness"
            : tab === "skills"
              ? (selectedSkill ?? "")
              : triage
                ? `${Math.min(cursor + 1, pending.length)} of ${pending.length}`
                : sel
                  ? scopeLabel(sel.scope)
                  : "";

    const sections: RailSection[] = [
        {
            id: "vault-detail",
            icon: RAIL_ICON.info,
            label: title,
            content: (
                <div className="flex flex-col gap-[18px]">
                    <div className="flex items-center gap-[9px]">
                        <SectionHead>{title}</SectionHead>
                        <div className="flex-1" />
                        <span className="font-mono text-[10.5px] text-ink-faint">{meta}</span>
                    </div>
                    <PlanCard />
                    <AnimatePresence mode="wait">
                        <motion.div
                            key={`${tab}-${triage ? "triage" : (selectedId ?? selectedSkill ?? "empty")}`}
                            initial={{ opacity: 0 }}
                            animate={{
                                opacity: 1,
                                transition: { duration: MOTION.durMacro, ease: MOTION.easeFluid },
                            }}
                            exit={{ opacity: 0, transition: { duration: MOTION.durExit, ease: MOTION.easeFluid } }}
                        >
                            {tab === "steering" ? (
                                <HarnessMode />
                            ) : tab === "skills" ? (
                                <SkillMode />
                            ) : triage ? (
                                <TriageMode />
                            ) : (
                                <NoteMode model={model} />
                            )}
                        </motion.div>
                    </AnimatePresence>
                </div>
            ),
        },
    ];

    return <CollapsibleRail openAtom={memRailOpenAtom} ariaLabel="Vault detail" sections={sections} />;
}
