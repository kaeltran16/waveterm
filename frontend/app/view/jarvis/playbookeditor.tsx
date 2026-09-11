// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Controlled editor for a playbook — the ordered phases a new pipeline run is composed from. It re-homes
// the phase editor that lost its mount when B5 deleted profilepanel.tsx. The playbook is live, not
// decorative: resolveRunPlan (wshserver_runs.go) composes every pipeline run from the resolved profile's
// phases, so between B5 and now the only way to change them was the RPC.
//
// It owns no policy — the caller decides whether it is editing a project override or the global list, and
// every affordance is a reducePlaybook action bubbled up through onChange.

import { PHASE_KINDS, reducePlaybook, type PlaybookAction } from "./profilemodel";

const mutedBtn = "cursor-pointer px-1 text-[11px] text-muted hover:text-secondary disabled:cursor-default";
const fieldBox = "rounded-sm border border-edge-mid bg-background px-1.5 py-1 text-[11px] text-primary";

function PhaseEditor({
    phase,
    index,
    count,
    dispatch,
}: {
    phase: RunPhase;
    index: number;
    count: number;
    dispatch: (a: PlaybookAction) => void;
}) {
    const update = (patch: Partial<RunPhase>) => dispatch({ type: "update", index, phase: { ...phase, ...patch } });
    return (
        <div data-jarvis-playbook="phase" className="rounded border border-edge-mid bg-surface p-2">
            <div className="flex items-center gap-1.5">
                <select value={phase.kind} onChange={(e) => update({ kind: e.target.value })} className={fieldBox}>
                    {PHASE_KINDS.map((k) => (
                        <option key={k} value={k}>
                            {k}
                        </option>
                    ))}
                </select>
                {/* the ends are absent rather than inert: the first phase has no "up" to press */}
                {index > 0 ? (
                    <button
                        type="button"
                        aria-label="Move phase earlier"
                        onClick={() => dispatch({ type: "move", index, dir: -1 })}
                        className={mutedBtn}
                    >
                        ↑
                    </button>
                ) : null}
                {index < count - 1 ? (
                    <button
                        type="button"
                        aria-label="Move phase later"
                        onClick={() => dispatch({ type: "move", index, dir: 1 })}
                        className={mutedBtn}
                    >
                        ↓
                    </button>
                ) : null}
                <button
                    type="button"
                    aria-label="Remove phase"
                    onClick={() => dispatch({ type: "remove", index })}
                    className="ml-auto cursor-pointer px-1 text-[11px] text-muted hover:text-error"
                >
                    ✕
                </button>
            </div>
            <input
                value={phase.skill ?? ""}
                onChange={(e) => update({ skill: e.target.value })}
                placeholder="skill (e.g. superpowers:writing-plans)"
                className="mt-1.5 w-full rounded-sm border border-edge-mid bg-background px-1.5 py-1 font-mono text-[11px] text-primary placeholder:text-muted focus:outline-none"
            />
            <div className="mt-1.5 flex gap-3">
                <label className="flex cursor-pointer items-center gap-1 text-[10.5px] text-secondary">
                    <input
                        type="checkbox"
                        checked={!!phase.gate}
                        onChange={(e) => update({ gate: e.target.checked })}
                    />
                    hold for review
                </label>
                <label className="flex cursor-pointer items-center gap-1 text-[10.5px] text-secondary">
                    <input
                        type="checkbox"
                        checked={!!phase.freshctx}
                        onChange={(e) => update({ freshctx: e.target.checked })}
                    />
                    fresh context
                </label>
            </div>
        </div>
    );
}

export function PlaybookEditor({
    phases,
    disabled = false,
    onChange,
}: {
    phases: RunPhase[];
    disabled?: boolean;
    onChange: (next: RunPhase[]) => void;
}) {
    const dispatch = (action: PlaybookAction) => onChange(reducePlaybook(phases, action));
    return (
        <fieldset
            disabled={disabled}
            data-jarvis-playbook="editor"
            className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0 disabled:opacity-60"
        >
            {phases.map((p, i) => (
                <PhaseEditor key={i} phase={p} index={i} count={phases.length} dispatch={dispatch} />
            ))}
            <button
                type="button"
                onClick={() => dispatch({ type: "add" })}
                className="cursor-pointer rounded-[7px] border border-dashed border-edge-mid py-1 text-[11px] text-muted hover:text-secondary"
            >
                + add phase
            </button>
        </fieldset>
    );
}

/** The inherited playbook, read-only: what a run in this project is composed from today, before the
 *  project decides to say something different. */
export function PlaybookSummary({ phases }: { phases: RunPhase[] }) {
    if (phases.length === 0) {
        return <span className="text-[11px] text-muted">No phases — a run falls back to the built-in pipeline.</span>;
    }
    return (
        <div data-jarvis-playbook="summary" className="flex flex-col gap-1">
            {phases.map((p, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px] text-secondary">
                    <span className="font-semibold">{p.kind}</span>
                    {p.skill ? <span className="truncate font-mono text-muted">{p.skill}</span> : null}
                    {p.gate ? <span className="font-mono text-[9px] uppercase text-asking">gate</span> : null}
                    {p.freshctx ? <span className="font-mono text-[9px] uppercase text-muted">fresh</span> : null}
                </div>
            ))}
        </div>
    );
}
