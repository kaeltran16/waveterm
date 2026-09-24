// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Controlled editor for a channel's principle patch. It renders the rows computed by principleRows()
// (presentation state only) and turns every affordance into a reducePrinciplePatch action bubbled up via
// onChange. It owns no policy: the merge/resolution rule lives in Go, and dirty/empty logic lives in
// profilemodel. Semantic <button>/<textarea> elements carry keyboard behavior from the platform.

import { cn } from "@/util/util";
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
    // a form fieldset, so an in-flight save makes the whole editor inert without threading a flag through
    // every row action.
    disabled?: boolean;
};

// the profile modal's panels: one bordered surface, rows split by faint rules
export const PROFILE_PANEL =
    "flex flex-col divide-y divide-edge-faint overflow-hidden rounded-[8px] border border-edge-mid bg-surface";
export const PRINCIPLE_ADD_BTN =
    "flex h-[38px] w-full cursor-pointer items-center justify-center gap-1.5 text-[12.5px] text-ink-mid hover:bg-surface-raised hover:text-secondary";
const EDIT_BOX =
    "field-sizing-content min-h-[52px] w-full resize-none rounded-[6px] border border-edge-mid bg-background px-[9px] py-[7px] text-[13px] leading-[1.5] text-primary placeholder:text-muted outline-none focus:border-accent/40";
const ROW_BTN = "h-[22px] cursor-pointer rounded-[5px] px-[7px] text-[12px] hover:bg-surface-raised";
const mutedBtn = `${ROW_BTN} text-ink-mid hover:text-secondary`;
const accentBtn = `${ROW_BTN} text-accent-soft hover:text-accent`;
const deleteBtn = `${ROW_BTN} text-ink-mid hover:text-error`;
const EDITING_ROW = "flex flex-col gap-[7px] bg-surface-raised px-3.5 pt-[11px] pb-3";

export function PlusIcon() {
    return (
        <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
        >
            <path d="M12 5v14M5 12h14" />
        </svg>
    );
}

// a tag only where the row differs from global; an inherited row says nothing
function RowTag({ kind }: { kind: "modified" | "project" }) {
    return (
        <span
            className={cn(
                "flex h-5 items-center rounded-[4px] px-[7px] text-[11.5px] font-semibold",
                kind === "modified" ? "bg-askingbg text-asking" : "bg-accentbg text-accent-soft"
            )}
        >
            {kind === "modified" ? "Customized" : "This project"}
        </span>
    );
}

function ActiveRow({ row, dispatch }: { row: PrincipleRow; dispatch: (a: PrinciplePatchAction) => void }) {
    if (row.kind === "inherited") {
        return (
            <div className="flex items-start gap-3.5 px-3.5 py-[11px]">
                <span className="flex-1 text-[13px] leading-[1.5] text-ink-hi">{row.text}</span>
                <div className="flex gap-1 pt-px">
                    <button
                        type="button"
                        onClick={() => dispatch({ type: "override", id: row.id, text: row.text })}
                        className={mutedBtn}
                    >
                        Customize
                    </button>
                    <button
                        type="button"
                        onClick={() => dispatch({ type: "disable", id: row.id })}
                        className={mutedBtn}
                    >
                        Disable
                    </button>
                </div>
            </div>
        );
    }
    if (row.kind === "modified") {
        return (
            <div className={EDITING_ROW}>
                <div className="flex items-center gap-2">
                    <RowTag kind="modified" />
                    <span className="flex-1" />
                    <button type="button" onClick={() => dispatch({ type: "reset", id: row.id })} className={mutedBtn}>
                        Use global
                    </button>
                </div>
                <textarea
                    aria-label="Customized principle text"
                    value={row.text}
                    onChange={(e) => dispatch({ type: "override", id: row.id, text: e.target.value })}
                    className={EDIT_BOX}
                />
                <span className="whitespace-pre-wrap text-[11.5px] leading-[1.4] text-muted">
                    Global: {row.originalText}
                </span>
            </div>
        );
    }
    // project addition
    return (
        <div className={EDITING_ROW}>
            <div className="flex items-center gap-2">
                <RowTag kind="project" />
                <span className="flex-1" />
                <button
                    type="button"
                    onClick={() => dispatch({ type: "delete-addition", id: row.id })}
                    className={deleteBtn}
                >
                    Delete
                </button>
            </div>
            <textarea
                aria-label="Project principle text"
                value={row.text}
                onChange={(e) => dispatch({ type: "update-addition", id: row.id, text: e.target.value })}
                placeholder="Project principle…"
                className={EDIT_BOX}
            />
        </div>
    );
}

export function PrinciplesEditor({ global, patch, diagnostics, onChange, disabled = false }: PrinciplesEditorProps) {
    const dispatch = (action: PrinciplePatchAction) => onChange(reducePrinciplePatch(patch, action));
    const rows = principleRows(global, patch, diagnostics);
    const active = rows.filter((r) => r.kind === "inherited" || r.kind === "modified" || r.kind === "project");
    const disabledRows = rows.filter((r) => r.kind === "disabled");
    const stale = rows.filter((r) => r.kind === "stale");
    return (
        <fieldset disabled={disabled} className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0 disabled:opacity-60">
            <div className={PROFILE_PANEL}>
                {active.map((row) => (
                    <ActiveRow key={row.id} row={row} dispatch={dispatch} />
                ))}
                <button
                    type="button"
                    onClick={() =>
                        dispatch({ type: "add", principle: { id: `project-${crypto.randomUUID()}`, text: "" } })
                    }
                    className={PRINCIPLE_ADD_BTN}
                >
                    <PlusIcon />
                    Add a project principle
                </button>
                {disabledRows.length > 0 ? (
                    <div className="flex flex-col gap-1.5 bg-background px-3.5 pt-2.5 pb-3">
                        <span className="text-[11.5px] font-semibold text-ink-mid">Disabled for this project</span>
                        {disabledRows.map((row) => (
                            <div key={row.id} className="flex items-center gap-3.5">
                                <span className="flex-1 text-[12.5px] leading-[1.45] text-muted line-through decoration-ink-faint">
                                    {row.text}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => dispatch({ type: "reenable", id: row.id })}
                                    className={accentBtn}
                                >
                                    Re-enable
                                </button>
                            </div>
                        ))}
                    </div>
                ) : null}
            </div>
            {stale.map((row) => (
                <div
                    key={row.id}
                    className="flex items-start gap-2 rounded-[8px] border border-warning/40 bg-warning/10 px-3.5 py-2.5"
                >
                    <span className="flex-1 text-[12px] leading-[1.45] text-warning">
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
                        className={deleteBtn}
                    >
                        Remove
                    </button>
                </div>
            ))}
        </fieldset>
    );
}
