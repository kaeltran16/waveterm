// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Jarvis profile editor: a CollapsibleRail slide-in that edits a channel's per-project profile
// override (playbook + principles). Loads the resolved profile from the backend (getJarvisProfile) on
// open; each section shows a global/project badge with Customize (copy the inherited global section into
// the editable override) and Reset-to-global (drop the override section). Save persists via
// setChannelProfile. Principles are editable but not yet consumed by any model (Piece 4).

import { CollapsibleRail, type RailSection } from "@/app/element/collapsiblerail";
import { fireAndForget } from "@/util/util";
import { atom, useAtomValue, type PrimitiveAtom } from "jotai";
import { useEffect, useState } from "react";
import { getJarvisProfile, setChannelProfile } from "./runactions";
import { isDirty } from "./profilemodel";

export const profileRailOpenAtom: PrimitiveAtom<boolean> = atom(false);

const PHASE_KINDS = ["brainstorm", "plan", "execute", "custom"] as const;

type Loaded = { global: JarvisProfile; override: ProfileOverride };

function omit(d: ProfileOverride, key: keyof ProfileOverride): ProfileOverride {
    const next = { ...d };
    delete next[key];
    return next;
}

function movePhase(phases: RunPhase[], i: number, dir: -1 | 1): RunPhase[] {
    const j = i + dir;
    if (j < 0 || j >= phases.length) {
        return phases;
    }
    const next = [...phases];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
}

function overrideIsEmpty(o: ProfileOverride): boolean {
    return o.playbook == null && o.principles == null && o.defaultmode == null && o.defaultplangate == null;
}

function Badge({ source }: { source: "global" | "project" }) {
    return (
        <span
            className={
                "rounded-[4px] px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-[.08em] " +
                (source === "project" ? "bg-accentbg/50 text-accent-soft" : "border border-edge-mid text-muted")
            }
        >
            {source}
        </span>
    );
}

function PhaseEditor({
    phase,
    onChange,
    onRemove,
    onMove,
}: {
    phase: RunPhase;
    onChange: (p: RunPhase) => void;
    onRemove: () => void;
    onMove: (dir: -1 | 1) => void;
}) {
    return (
        <div className="rounded border border-edge-mid bg-surface p-2">
            <div className="flex items-center gap-1.5">
                <select
                    value={phase.kind}
                    onChange={(e) => onChange({ ...phase, kind: e.target.value })}
                    className="rounded-sm border border-edge-mid bg-background px-1.5 py-1 text-[11px] text-primary"
                >
                    {PHASE_KINDS.map((k) => (
                        <option key={k} value={k}>
                            {k}
                        </option>
                    ))}
                </select>
                <button type="button" onClick={() => onMove(-1)} className="px-1 text-[11px] text-muted hover:text-secondary">
                    ↑
                </button>
                <button type="button" onClick={() => onMove(1)} className="px-1 text-[11px] text-muted hover:text-secondary">
                    ↓
                </button>
                <button type="button" onClick={onRemove} className="ml-auto px-1 text-[11px] text-muted hover:text-error">
                    ✕
                </button>
            </div>
            <input
                value={phase.skill ?? ""}
                onChange={(e) => onChange({ ...phase, skill: e.target.value })}
                placeholder="skill (e.g. superpowers:writing-plans)"
                className="mt-1.5 w-full rounded-sm border border-edge-mid bg-background px-1.5 py-1 font-mono text-[11px] text-primary placeholder:text-muted focus:outline-none"
            />
            <div className="mt-1.5 flex gap-3">
                <label className="flex cursor-pointer items-center gap-1 text-[10.5px] text-secondary">
                    <input type="checkbox" checked={!!phase.gate} onChange={(e) => onChange({ ...phase, gate: e.target.checked })} />
                    GATE
                </label>
                <label className="flex cursor-pointer items-center gap-1 text-[10.5px] text-secondary">
                    <input
                        type="checkbox"
                        checked={!!phase.freshctx}
                        onChange={(e) => onChange({ ...phase, freshctx: e.target.checked })}
                    />
                    FRESH-CTX
                </label>
            </div>
        </div>
    );
}

function PlaybookSection({
    global,
    draft,
    setDraft,
}: {
    global: JarvisProfile;
    draft: ProfileOverride;
    setDraft: React.Dispatch<React.SetStateAction<ProfileOverride>>;
}) {
    const overridden = draft.playbook != null;
    const phases = draft.playbook ?? global.playbook ?? [];
    const setPhases = (next: RunPhase[]) => setDraft((d) => ({ ...d, playbook: next }));
    return (
        <div>
            <div className="mb-1.5 flex items-center gap-2">
                <span className="text-[12px] font-semibold text-primary">Playbook</span>
                <Badge source={overridden ? "project" : "global"} />
                <div className="flex-1" />
                {overridden ? (
                    <button
                        type="button"
                        onClick={() => setDraft((d) => omit(d, "playbook"))}
                        className="text-[10px] text-muted hover:text-secondary"
                    >
                        reset to global
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={() => setPhases((global.playbook ?? []).map((p) => ({ ...p })))}
                        className="text-[10px] text-accent-soft hover:text-accent"
                    >
                        customize
                    </button>
                )}
            </div>
            {overridden ? (
                <div className="flex flex-col gap-2">
                    {phases.map((p, i) => (
                        <PhaseEditor
                            key={i}
                            phase={p}
                            onChange={(np) => setPhases(phases.map((x, j) => (j === i ? np : x)))}
                            onRemove={() => setPhases(phases.filter((_, j) => j !== i))}
                            onMove={(dir) => setPhases(movePhase(phases, i, dir))}
                        />
                    ))}
                    <button
                        type="button"
                        onClick={() => setPhases([...phases, { kind: "custom", state: "pending" }])}
                        className="rounded-[7px] border border-dashed border-edge-mid py-1 text-[11px] text-muted hover:text-secondary"
                    >
                        + add phase
                    </button>
                </div>
            ) : (
                <div className="flex flex-col gap-1">
                    {phases.map((p, i) => (
                        <div key={i} className="flex items-center gap-2 text-[11px] text-secondary">
                            <span className="font-semibold">{p.kind}</span>
                            {p.skill ? <span className="font-mono text-muted">{p.skill}</span> : null}
                            {p.gate ? <span className="font-mono text-[9px] text-asking">GATE</span> : null}
                            {p.freshctx ? <span className="font-mono text-[9px] text-muted">FRESH</span> : null}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function PrinciplesSection({
    global,
    draft,
    setDraft,
}: {
    global: JarvisProfile;
    draft: ProfileOverride;
    setDraft: React.Dispatch<React.SetStateAction<ProfileOverride>>;
}) {
    const overridden = draft.principles != null;
    const value = draft.principles ?? global.principles ?? "";
    return (
        <div>
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <span className="text-[12px] font-semibold text-primary">Principles</span>
                <Badge source={overridden ? "project" : "global"} />
                <span className="font-mono text-[9px] text-muted">(not yet applied · Piece 4)</span>
                <div className="flex-1" />
                {overridden ? (
                    <button
                        type="button"
                        onClick={() => setDraft((d) => omit(d, "principles"))}
                        className="text-[10px] text-muted hover:text-secondary"
                    >
                        reset to global
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={() => setDraft((d) => ({ ...d, principles: global.principles ?? "" }))}
                        className="text-[10px] text-accent-soft hover:text-accent"
                    >
                        customize
                    </button>
                )}
            </div>
            {overridden ? (
                <textarea
                    value={value}
                    onChange={(e) => setDraft((d) => ({ ...d, principles: e.target.value }))}
                    rows={6}
                    className="w-full rounded border border-edge-mid bg-background p-2 text-[11.5px] leading-[1.5] text-primary focus:outline-none"
                />
            ) : (
                <div className="whitespace-pre-wrap rounded border border-edge-mid bg-surface p-2 text-[11px] leading-[1.5] text-muted">
                    {value || "—"}
                </div>
            )}
        </div>
    );
}

function DefaultsSection({
    global,
    draft,
    setDraft,
}: {
    global: JarvisProfile;
    draft: ProfileOverride;
    setDraft: React.Dispatch<React.SetStateAction<ProfileOverride>>;
}) {
    const mode = draft.defaultmode ?? global.defaultmode ?? "pipeline";
    const gate = draft.defaultplangate ?? global.defaultplangate ?? true;
    const overridden = draft.defaultmode != null || draft.defaultplangate != null;
    return (
        <div>
            <div className="mb-1.5 flex items-center gap-2">
                <span className="text-[12px] font-semibold text-primary">Run defaults</span>
                <Badge source={overridden ? "project" : "global"} />
                <div className="flex-1" />
                {overridden ? (
                    <button
                        type="button"
                        onClick={() => setDraft((d) => omit(omit(d, "defaultmode"), "defaultplangate"))}
                        className="text-[10px] text-muted hover:text-secondary"
                    >
                        reset to global
                    </button>
                ) : null}
            </div>
            <div className="flex items-center gap-2">
                <select
                    value={mode}
                    onChange={(e) => setDraft((d) => ({ ...d, defaultmode: e.target.value }))}
                    className="rounded-sm border border-edge-mid bg-background px-1.5 py-1 text-[11px] text-primary"
                >
                    <option value="pipeline">pipeline</option>
                    <option value="orchestrator">orchestrator</option>
                </select>
                {mode === "orchestrator" ? (
                    <label className="flex cursor-pointer items-center gap-1 text-[11px] text-secondary">
                        <input
                            type="checkbox"
                            checked={gate}
                            onChange={(e) => setDraft((d) => ({ ...d, defaultplangate: e.target.checked }))}
                        />
                        plan gate on by default
                    </label>
                ) : null}
            </div>
        </div>
    );
}

export function ProfilePanel({ channelId }: { channelId: string }) {
    const open = useAtomValue(profileRailOpenAtom);
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [draft, setDraft] = useState<ProfileOverride>({});
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open) {
            return;
        }
        // reset per open/channel so a stale load never lingers; a failed load surfaces instead of
        // sticking on "Loading…" forever (e.g. the channel was deleted out from under the drawer).
        setLoaded(null);
        setError(null);
        fireAndForget(async () => {
            try {
                const p = await getJarvisProfile(channelId);
                setLoaded({ global: p.global, override: p.override ?? {} });
                setDraft(p.override ?? {});
            } catch (e) {
                setError(String(e));
            }
        });
    }, [open, channelId]);

    const save = () => {
        if (!loaded) {
            return;
        }
        setSaving(true);
        fireAndForget(async () => {
            try {
                await setChannelProfile(channelId, draft);
                setLoaded((l) => (l ? { ...l, override: overrideIsEmpty(draft) ? {} : draft } : l));
            } finally {
                setSaving(false);
            }
        });
    };

    const body = loaded ? (
        <div className="flex flex-col gap-5">
            <div className="text-[10px] font-semibold uppercase tracking-[.08em] text-muted">
                Jarvis profile · merged (global + this project)
            </div>
            <PlaybookSection global={loaded.global} draft={draft} setDraft={setDraft} />
            <PrinciplesSection global={loaded.global} draft={draft} setDraft={setDraft} />
            <DefaultsSection global={loaded.global} draft={draft} setDraft={setDraft} />
        </div>
    ) : error ? (
        <div className="text-[12px] leading-[1.5] text-error">Couldn't load the profile. {error}</div>
    ) : (
        <div className="text-[12px] text-muted">Loading…</div>
    );

    const footer = loaded ? (
        <button
            type="button"
            disabled={saving || !isDirty(draft, loaded.override)}
            onClick={save}
            className="w-full rounded bg-accent py-2 text-[12px] font-semibold text-background hover:bg-accenthover disabled:opacity-40"
        >
            {saving ? "Saving…" : "Save"}
        </button>
    ) : null;

    const sections: RailSection[] = [
        { id: "profile", icon: <span className="text-[16px]">⚙</span>, label: "Profile", content: body },
    ];
    // no collapsed strip of its own: the ⚙ trigger lives in the channel context rail's collapsed strip
    // (see ChannelsSurface), so profile stays its own drawer without doubling up the right-edge column.
    return (
        <CollapsibleRail
            openAtom={profileRailOpenAtom}
            ariaLabel="Jarvis profile"
            sections={sections}
            footer={footer}
            hideWhenCollapsed
        />
    );
}
