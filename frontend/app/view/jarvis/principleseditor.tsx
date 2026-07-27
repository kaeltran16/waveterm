// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Controlled editor for a channel's principle patch. It renders the rows computed by principleRows()
// (presentation state only) and turns every affordance into a reducePrinciplePatch action bubbled up via
// onChange. It owns no policy: the merge/resolution rule lives in Go, and dirty/empty logic lives in
// profilemodel. Semantic <button>/<textarea>/<details> elements carry keyboard behavior from the platform.

import {
    DIAGNOSTIC_MISSING_DISABLED,
    principleRows,
    reducePrinciplePatch,
    type PrinciplePatchAction,
    type PrincipleRow,
} from "./profilemodel";

type PrinciplesEditorProps = {
    global: Principle[];
    patch: PrinciplePatch | undefined;
    diagnostics: PrincipleDiagnostic[];
    onChange: (patch: PrinciplePatch | undefined) => void;
};

const badgeBase = "rounded-[4px] px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-[.08em]";
const accentBtn = "text-[10px] text-accent-soft hover:text-accent";
const mutedBtn = "text-[10px] text-muted hover:text-secondary";
const dangerBtn = "text-[10px] text-muted hover:text-error";
const editBox =
    "mt-1 w-full rounded border border-edge-mid bg-background p-2 text-[11.5px] leading-[1.5] text-primary placeholder:text-muted focus:outline-none";

function RowBadge({ kind }: { kind: "global" | "modified" | "project" }) {
    const tone =
        kind === "global"
            ? "border border-edge-mid text-muted"
            : kind === "modified"
              ? "bg-warning/10 text-warning"
              : "bg-accentbg/50 text-accent-soft";
    return <span className={`${badgeBase} ${tone}`}>{kind}</span>;
}

function ActiveRow({ row, dispatch }: { row: PrincipleRow; dispatch: (a: PrinciplePatchAction) => void }) {
    if (row.kind === "inherited") {
        return (
            <div className="rounded border border-edge-mid bg-surface p-2">
                <div className="flex items-center gap-2">
                    <RowBadge kind="global" />
                    <div className="flex-1" />
                    <button
                        type="button"
                        onClick={() => dispatch({ type: "override", id: row.id, text: row.text })}
                        className={accentBtn}
                    >
                        override
                    </button>
                    <button type="button" onClick={() => dispatch({ type: "disable", id: row.id })} className={mutedBtn}>
                        disable
                    </button>
                </div>
                <div className="mt-1 text-[11.5px] leading-[1.5] text-secondary">{row.text}</div>
            </div>
        );
    }
    if (row.kind === "modified") {
        return (
            <div className="rounded border border-edge-mid bg-surface p-2">
                <div className="flex items-center gap-2">
                    <RowBadge kind="modified" />
                    <div className="flex-1" />
                    <button type="button" onClick={() => dispatch({ type: "reset", id: row.id })} className={mutedBtn}>
                        reset
                    </button>
                </div>
                <textarea
                    value={row.text}
                    onChange={(e) => dispatch({ type: "override", id: row.id, text: e.target.value })}
                    rows={2}
                    className={editBox}
                />
                <details className="mt-1">
                    <summary className="cursor-pointer text-[10px] text-muted hover:text-secondary">original</summary>
                    <div className="mt-1 whitespace-pre-wrap text-[10.5px] leading-[1.4] text-muted">{row.originalText}</div>
                </details>
            </div>
        );
    }
    // project addition
    return (
        <div className="rounded border border-edge-mid bg-surface p-2">
            <div className="flex items-center gap-2">
                <RowBadge kind="project" />
                <div className="flex-1" />
                <button type="button" onClick={() => dispatch({ type: "delete-addition", id: row.id })} className={dangerBtn}>
                    delete
                </button>
            </div>
            <textarea
                value={row.text}
                onChange={(e) => dispatch({ type: "update-addition", id: row.id, text: e.target.value })}
                rows={2}
                placeholder="Project principle…"
                className={editBox}
            />
        </div>
    );
}

export function PrinciplesEditor({ global, patch, diagnostics, onChange }: PrinciplesEditorProps) {
    const dispatch = (action: PrinciplePatchAction) => onChange(reducePrinciplePatch(patch, action));
    const rows = principleRows(global, patch, diagnostics);
    const active = rows.filter((r) => r.kind === "inherited" || r.kind === "modified" || r.kind === "project");
    const disabled = rows.filter((r) => r.kind === "disabled");
    const stale = rows.filter((r) => r.kind === "stale");
    return (
        <div className="flex flex-col gap-2">
            {active.map((row) => (
                <ActiveRow key={row.id} row={row} dispatch={dispatch} />
            ))}
            <button
                type="button"
                onClick={() => dispatch({ type: "add", principle: { id: `project-${crypto.randomUUID()}`, text: "" } })}
                className="rounded-[7px] border border-dashed border-edge-mid py-1 text-[11px] text-muted hover:text-secondary"
            >
                + add principle
            </button>
            {disabled.length > 0 ? (
                <details className="rounded border border-edge-mid bg-surface">
                    <summary className="cursor-pointer px-2 py-1 text-[11px] text-secondary">
                        Disabled · {disabled.length}
                    </summary>
                    <div className="flex flex-col gap-1 px-2 pb-2">
                        {disabled.map((row) => (
                            <div key={row.id} className="flex items-center gap-2">
                                <span className="flex-1 text-[11px] text-muted line-through">{row.text}</span>
                                <button
                                    type="button"
                                    onClick={() => dispatch({ type: "reenable", id: row.id })}
                                    className={accentBtn}
                                >
                                    re-enable
                                </button>
                            </div>
                        ))}
                    </div>
                </details>
            ) : null}
            {stale.map((row) => (
                <div key={row.id} className="flex items-start gap-2 rounded border border-warning/40 bg-warning/10 p-2">
                    <span className="flex-1 text-[10.5px] leading-[1.4] text-warning">
                        This project customized a principle ({row.id}) that no longer exists in the global set.
                    </span>
                    <button
                        type="button"
                        onClick={() =>
                            dispatch(
                                row.diagnostic === DIAGNOSTIC_MISSING_DISABLED
                                    ? { type: "reenable", id: row.id }
                                    : { type: "reset", id: row.id }
                            )
                        }
                        className={dangerBtn}
                    >
                        remove
                    </button>
                </div>
            ))}
        </div>
    );
}
