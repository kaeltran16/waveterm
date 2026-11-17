// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The design card (confirm guesses, keep talking, Check with a builder), in the Rendered transcript: the pane's review
// head, each decision in one line with That's right and Edit, what the agent found, and, once every decision is yours,
// the one press to Check with a builder. A pick or a send goes the pane's way (pickPart, sendBrainstorm).

import { TickNumber } from "@/app/element/ticknumber";
import { cn } from "@/util/util";
import { ArrowUpRight } from "lucide-react";
import type { JSX } from "react";
import {
    builderCheckView,
    editLock,
    type BrainstormAction,
    type BuilderCheckView,
    type PartPick,
} from "./brainstormmodel";
import { pickPart, sendBrainstorm } from "./brainstormsend";
import { openBrainstormAt, shownPicks } from "./brainstormstore";
import {
    DOT,
    DOT_ASKED,
    DOT_GUESS,
    DOT_OPEN,
    DOT_YOURS,
    ErrorLine,
    lockTitle,
    PART_BTN,
    PickButton,
    useAction,
} from "./brainstormui";
import { CANVAS_PRIMARY_BTN } from "./canvaspane";
import { CardFrame } from "./renderedbrainstorm";
import type { CardProps } from "./renderedbrainstormmodel";
import { designView, type DesignRow } from "./renderedbsdesignmodel";

const LINK =
    "inline-flex cursor-pointer items-center gap-1 whitespace-nowrap border-0 bg-transparent p-0 text-[12px] text-accent-soft hover:underline";
const QUIET_BTN =
    "cursor-pointer whitespace-nowrap border-0 bg-transparent px-[2px] py-[4px] text-[12px] text-ink-mid hover:text-secondary disabled:cursor-default disabled:opacity-50";

// a decision the agent changed after you confirmed it keeps its dashed ring, with an accent edge
const ROW_DOT: Record<DesignRow["view"], string> = {
    yours: DOT_YOURS,
    guess: DOT_GUESS,
    changed: cn(DOT, "box-border border-[1.5px] border-accent"),
    asked: DOT_ASKED,
    writing: DOT_YOURS,
    open: DOT_OPEN,
};

type RowProps = {
    row: DesignRow;
    pressed: boolean;
    dimmed: boolean;
    locked: boolean;
    title: string | undefined;
    compact: boolean;
    onPick: (pick: PartPick) => void;
    onOpenPart: () => void;
    onOpenBoard: (board: string) => void;
};

// one decision in a line: dot, title, gist, its board; what to do with it under the line when the column is narrow
function DesignRowView({ row, pressed, dimmed, locked, title, compact, onPick, onOpenPart, onOpenBoard }: RowProps) {
    const actions =
        row.pick != null ? (
            <div data-rendered-bs-design-actions className="flex flex-none items-center gap-[8px]">
                {row.view === "changed" ? (
                    <span data-rendered-bs-changed className="text-[11.5px] text-accent-soft">
                        changed
                    </span>
                ) : null}
                <PickButton
                    label="That’s right"
                    pressed={pressed}
                    dimmed={dimmed}
                    className={PART_BTN}
                    disabled={locked}
                    title={title}
                    onClick={() => onPick(row.pick!)}
                />
                <button type="button" disabled={locked} title={title} onClick={onOpenPart} className={QUIET_BTN}>
                    Edit
                </button>
            </div>
        ) : null;
    return (
        <div
            data-rendered-bs-design-row={row.id}
            data-state={row.view}
            className={cn(
                "flex border-t border-edge-faint py-[9px]",
                compact ? "flex-col gap-[6px]" : "items-start gap-[12px]"
            )}
        >
            <div className={cn("flex min-w-0 flex-1 gap-[12px]", compact ? "items-start" : "items-baseline")}>
                <span className={cn(ROW_DOT[row.view], "mt-[6px] self-start")} />
                <div
                    className={cn(
                        "flex min-w-0 flex-1 gap-x-[14px]",
                        compact ? "flex-col gap-[2px]" : "items-baseline"
                    )}
                >
                    <button
                        type="button"
                        data-rendered-bs-part-link
                        onClick={onOpenPart}
                        className={cn(
                            "cursor-pointer border-0 bg-transparent p-0 text-left font-semibold text-primary hover:underline",
                            compact ? "text-[12.5px]" : "w-[160px] flex-none text-[13px]"
                        )}
                    >
                        {row.title}
                    </button>
                    <span
                        data-rendered-bs-design-gist
                        className={cn("min-w-0 leading-[1.45] text-secondary", compact ? "text-[12px]" : "text-[13px]")}
                    >
                        {row.gist}
                    </span>
                </div>
                {row.board != null ? (
                    <button
                        type="button"
                        data-rendered-bs-board-link
                        onClick={() => onOpenBoard(row.board!)}
                        className={cn(LINK, "flex-none font-mono")}
                    >
                        {row.board}
                    </button>
                ) : null}
            </div>
            {actions != null ? <div className={compact ? "pl-[19px]" : "flex-none"}>{actions}</div> : null}
        </div>
    );
}

export function DesignCard({ agent, s, f, compact }: CardProps): JSX.Element | null {
    const act = useAction();
    const check: BuilderCheckView = builderCheckView(
        agent.builderCheck,
        s.sentCheckAt,
        s.file,
        s.modifiedMs,
        agent,
        s.turnStartMs,
        s.checkTakenTs
    );
    const v = designView(f, s.base, check);
    const lock = editLock(f, check);
    const locked = lock != null || act.busy;
    const title = lockTitle(lock);
    const picks = shownPicks(s);
    const send = (a: BrainstormAction) =>
        void act.run(() => sendBrainstorm(agent, a, undefined, undefined, "transcript"));
    const primary = cn(CANVAS_PRIMARY_BTN, "flex-none");
    return (
        <CardFrame
            agent={agent}
            s={s}
            f={f}
            asking={true}
            head={
                <span className="whitespace-nowrap font-mono font-semibold">
                    {v.settled ? "The design" : "Confirm the design"}
                </span>
            }
            compact={compact}
            attr="data-rendered-bs-design"
        >
            <div className={cn("flex gap-[14px]", compact ? "flex-col" : "items-center")}>
                <span
                    data-rendered-bs-design-line
                    className={cn(
                        "min-w-0 flex-1 leading-[1.5] text-ink-mid",
                        compact ? "text-[12.5px]" : "text-[13.5px]"
                    )}
                >
                    {v.line}
                </span>
                {v.confirmAll != null ? (
                    <button
                        type="button"
                        data-rendered-bs-confirm-all
                        disabled={locked}
                        title={title}
                        onClick={() => send({ kind: "confirm-all" })}
                        className={cn(primary, compact && "self-start")}
                    >
                        <span>
                            Confirm all <TickNumber value={v.confirmAll} /> guesses
                        </span>
                    </button>
                ) : null}
                {v.settled && v.check ? (
                    <button
                        type="button"
                        data-rendered-bs-check-btn
                        disabled={locked}
                        title={title}
                        onClick={() => send({ kind: "check" })}
                        className={cn(primary, compact && "self-start")}
                    >
                        Check with a builder
                    </button>
                ) : null}
            </div>
            {v.settled ? null : (
                <div data-rendered-bs-design-rows className="flex flex-col">
                    {v.rows.map((r) => (
                        <DesignRowView
                            key={r.id}
                            row={r}
                            pressed={r.pick != null && picks[r.id] === r.pick}
                            dimmed={picks[r.id] != null}
                            locked={locked}
                            title={title}
                            compact={compact}
                            onPick={(pick) => void act.run(() => pickPart(agent, r.id, pick))}
                            onOpenPart={() => openBrainstormAt(agent.id, { part: r.id })}
                            onOpenBoard={(board) => openBrainstormAt(agent.id, { board })}
                        />
                    ))}
                </div>
            )}
            {v.notes.length > 0 && !v.settled ? (
                <div
                    data-rendered-bs-found
                    className={cn(
                        "flex gap-x-[10px] gap-y-1 text-[12.5px] text-ink-mid",
                        compact ? "flex-wrap" : "items-baseline"
                    )}
                >
                    <span className="font-semibold text-secondary">What the agent found · {v.notes.length}</span>
                    <span className="min-w-0 truncate">{v.notes.map((n) => n.title).join(" · ")}</span>
                    <span className="flex-1" />
                    <button
                        type="button"
                        data-rendered-bs-read-found
                        onClick={() => openBrainstormAt(agent.id, { part: v.notes[0].id })}
                        className={LINK}
                    >
                        Read in the brainstorm
                        <ArrowUpRight size={11} strokeWidth={2.2} aria-hidden />
                    </button>
                </div>
            ) : null}
            {v.waiting != null ? (
                <span data-rendered-bs-design-waiting className="text-[12px] text-muted">
                    {v.waiting}
                </span>
            ) : null}
            <ErrorLine error={act.error} attrs={{ "data-rendered-bs-error": "" }} />
        </CardFrame>
    );
}
