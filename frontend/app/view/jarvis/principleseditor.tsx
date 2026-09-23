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
    // a form fieldset, so an in-flight save makes the whole editor inert without threading a flag through
    // every row action.
    disabled?: boolean;
};

// the design's principle cards (design L932-957)
export const PRINCIPLE_CARD = "rounded-[7px] border border-edge-mid bg-surface px-2.5 py-2";
export const PRINCIPLE_EDIT_BOX =
    "mt-[5px] w-full resize-none rounded-[6px] border border-edge-mid bg-background px-2 py-1.5 text-[12px] leading-[1.5] text-primary placeholder:text-muted outline-none focus:border-accent/60";
export const PRINCIPLE_ADD_BTN =
    "cursor-pointer rounded-[7px] border border-dashed border-edge-mid p-1.5 text-[11.5px] text-ink-mid hover:border-edge-strong hover:text-secondary";
export const PRINCIPLE_DELETE_BTN = "cursor-pointer text-[10.5px] text-ink-mid hover:text-error";
const badgeBase = "rounded-[4px] border px-1.5 py-px font-mono text-[10.5px] font-semibold uppercase tracking-[.08em]";
const accentBtn = "cursor-pointer text-[10.5px] text-accent-soft hover:text-accent";
const mutedBtn = "cursor-pointer text-[10.5px] text-ink-mid hover:text-secondary";

function RowBadge({ kind }: { kind: "global" | "modified" | "project" }) {
    const tone =
        kind === "global"
            ? "border-edge-mid text-ink-mid"
            : kind === "modified"
              ? "border-transparent bg-asking/10 text-asking"
              : "border-transparent bg-accent/8 text-accent-soft";
    return <span className={`${badgeBase} ${tone}`}>{kind}</span>;
}

function ActiveRow({ row, dispatch }: { row: PrincipleRow; dispatch: (a: PrinciplePatchAction) => void }) {
    if (row.kind === "inherited") {
        return (
            <div className={PRINCIPLE_CARD}>
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
                <div className="mt-[5px] text-[12px] leading-[1.5] text-secondary">{row.text}</div>
            </div>
        );
    }
    if (row.kind === "modified") {
        return (
            <div className={PRINCIPLE_CARD}>
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
                    className={PRINCIPLE_EDIT_BOX}
                />
                <div className="mt-1 whitespace-pre-wrap text-[10.5px] leading-[1.4] text-ink-mid">
                    original · {row.originalText}
                </div>
            </div>
        );
    }
    // project addition
    return (
        <div className={PRINCIPLE_CARD}>
            <div className="flex items-center gap-2">
                <RowBadge kind="project" />
                <div className="flex-1" />
                <button
                    type="button"
                    onClick={() => dispatch({ type: "delete-addition", id: row.id })}
                    className={PRINCIPLE_DELETE_BTN}
                >
                    delete
                </button>
            </div>
            <textarea
                value={row.text}
                onChange={(e) => dispatch({ type: "update-addition", id: row.id, text: e.target.value })}
                rows={2}
                placeholder="Project principle…"
                className={PRINCIPLE_EDIT_BOX}
            />
        </div>
    );
}

export function PrinciplesEditor({
    global,
    patch,
    diagnostics,
    onChange,
    disabled = false,
}: PrinciplesEditorProps) {
    const dispatch = (action: PrinciplePatchAction) => onChange(reducePrinciplePatch(patch, action));
    const rows = principleRows(global, patch, diagnostics);
    const active = rows.filter((r) => r.kind === "inherited" || r.kind === "modified" || r.kind === "project");
    const disabledRows = rows.filter((r) => r.kind === "disabled");
    const stale = rows.filter((r) => r.kind === "stale");
    return (
        <fieldset
            disabled={disabled}
            className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0 disabled:opacity-60"
        >
            {active.map((row) => (
                <ActiveRow key={row.id} row={row} dispatch={dispatch} />
            ))}
            <button
                type="button"
                onClick={() => dispatch({ type: "add", principle: { id: `project-${crypto.randomUUID()}`, text: "" } })}
                className={PRINCIPLE_ADD_BTN}
            >
                + add principle
            </button>
            {disabledRows.length > 0 ? (
                <div className="rounded-[7px] border border-edge-mid bg-surface px-2.5 py-[7px]">
                    <div className="text-[11px] text-secondary">Disabled · {disabledRows.length}</div>
                    <div className="flex flex-col">
                        {disabledRows.map((row) => (
                            <div key={row.id} className="mt-[5px] flex items-center gap-2">
                                <span className="flex-1 text-[11.5px] text-ink-mid line-through">{row.text}</span>
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
                </div>
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
                        className={PRINCIPLE_DELETE_BTN}
                    >
                        remove
                    </button>
                </div>
            ))}
        </fieldset>
    );
}
