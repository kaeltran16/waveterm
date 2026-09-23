// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Controlled editor for the global principle list. Separate from PrinciplesEditor on purpose: a project
// edits a *patch* against a baseline (override / disable / inherit), and none of those three affordances
// mean anything when the list you are editing IS the baseline. Global scope is a plain ordered list, and
// reduceGlobalPrinciples is its pure reducer.

import { PRINCIPLE_ADD_BTN, PRINCIPLE_CARD, PRINCIPLE_DELETE_BTN, PRINCIPLE_EDIT_BOX } from "./principleseditor";
import { reduceGlobalPrinciples, type GlobalPrincipleAction } from "./profilemodel";

export function GlobalPrinciplesEditor({
    principles,
    disabled = false,
    onChange,
}: {
    principles: Principle[];
    disabled?: boolean;
    onChange: (list: Principle[]) => void;
}) {
    const dispatch = (action: GlobalPrincipleAction) => onChange(reduceGlobalPrinciples(principles, action));
    return (
        <fieldset
            disabled={disabled}
            data-jarvis-global-principles="editor"
            className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0 disabled:opacity-60"
        >
            {principles.map((p, i) => (
                <div key={p.id} className={PRINCIPLE_CARD}>
                    <div className="flex items-center gap-1.5">
                        {i > 0 ? (
                            <button
                                type="button"
                                aria-label="Move principle up"
                                onClick={() => dispatch({ type: "move", id: p.id, dir: -1 })}
                                className="cursor-pointer px-1 text-[11px] text-ink-mid hover:text-secondary"
                            >
                                ↑
                            </button>
                        ) : null}
                        {i < principles.length - 1 ? (
                            <button
                                type="button"
                                aria-label="Move principle down"
                                onClick={() => dispatch({ type: "move", id: p.id, dir: 1 })}
                                className="cursor-pointer px-1 text-[11px] text-ink-mid hover:text-secondary"
                            >
                                ↓
                            </button>
                        ) : null}
                        <div className="flex-1" />
                        <button
                            type="button"
                            onClick={() => dispatch({ type: "delete", id: p.id })}
                            className={PRINCIPLE_DELETE_BTN}
                        >
                            delete
                        </button>
                    </div>
                    <textarea
                        value={p.text}
                        onChange={(e) => dispatch({ type: "update", id: p.id, text: e.target.value })}
                        rows={2}
                        placeholder="Global principle…"
                        className={PRINCIPLE_EDIT_BOX}
                    />
                </div>
            ))}
            <button
                type="button"
                onClick={() => dispatch({ type: "add", principle: { id: `custom-${crypto.randomUUID()}`, text: "" } })}
                className={PRINCIPLE_ADD_BTN}
            >
                + add principle
            </button>
        </fieldset>
    );
}
