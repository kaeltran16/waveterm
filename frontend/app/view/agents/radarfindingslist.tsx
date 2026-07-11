// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import {
    DEFAULT_OPEN_GROUPS,
    findingSignalCount,
    groupFindings,
    groupMeta,
    GROUP_ORDER,
    isMutedGroup,
    strengthPips,
    type RadarGroup,
} from "./radarmodel";
import { severityPill, TONE_DOT, TONE_TEXT } from "./radarstyles";

function StrengthPips({ strength }: { strength: string }) {
    const filled = strengthPips(strength);
    return (
        <span className="flex items-center gap-1">
            <span className="flex gap-0.5">
                {[0, 1, 2].map((i) => (
                    <span key={i} className={cn("h-2.5 w-1 rounded-[1px]", i < filled ? "bg-accent-soft" : "bg-border")} />
                ))}
            </span>
            <span className="text-[9px] uppercase tracking-wide text-muted">{strength}</span>
        </span>
    );
}

export function RadarFindingsList({
    findings,
    selectedId,
    onSelect,
}: {
    findings: RadarFinding[];
    selectedId: string | undefined;
    onSelect: (id: string) => void;
}) {
    const grouped = groupFindings(findings);
    const [open, setOpen] = useState<Set<RadarGroup>>(() => new Set(DEFAULT_OPEN_GROUPS));
    const toggle = (g: RadarGroup) =>
        setOpen((prev) => {
            const next = new Set(prev);
            next.has(g) ? next.delete(g) : next.add(g);
            return next;
        });

    return (
        <div className="flex w-[360px] shrink-0 flex-col overflow-y-auto border-r border-border py-2">
            {GROUP_ORDER.map((g) => {
                const items = grouped[g];
                if (items.length === 0) {
                    return null;
                }
                const meta = groupMeta(g);
                const isOpen = open.has(g);
                return (
                    <div key={g} className="mb-2">
                        <button
                            type="button"
                            onClick={() => toggle(g)}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left"
                        >
                            {isOpen ? (
                                <ChevronDown className="h-3 w-3 text-muted" />
                            ) : (
                                <ChevronRight className="h-3 w-3 text-muted" />
                            )}
                            <span className={cn("h-1.5 w-1.5 rounded-full", TONE_DOT[meta.tone])} />
                            <span className={cn("text-[10px] font-semibold uppercase tracking-wider", TONE_TEXT[meta.tone])}>
                                {meta.label}
                            </span>
                            <span className="rounded-full bg-surface px-1.5 text-[10px] font-semibold text-muted-foreground">
                                {items.length}
                            </span>
                            <span className="flex-1" />
                            <span className="text-[10px] text-muted">{meta.hint}</span>
                        </button>
                        {isOpen
                            ? items.map((f) => {
                                  const active = selectedId === f.id;
                                  const muted = isMutedGroup(f.group);
                                  const fmeta = groupMeta(f.group);
                                  return (
                                      <button
                                          key={f.id}
                                          type="button"
                                          onClick={() => onSelect(f.id)}
                                          className={cn(
                                              "relative flex w-full flex-col gap-2 border-l-2 px-3.5 py-2.5 text-left",
                                              active
                                                  ? "border-accent bg-accent/10"
                                                  : "border-transparent hover:bg-surface-hover",
                                              muted && !active && "opacity-70"
                                          )}
                                      >
                                          <div className="flex items-center gap-2">
                                              <span
                                                  className={cn(
                                                      "rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide",
                                                      severityPill(f.severity)
                                                  )}
                                              >
                                                  {f.severity}
                                              </span>
                                              <span className="truncate font-mono text-[10px] text-muted">{f.subsystem}</span>
                                              <span className="flex-1" />
                                              {!muted ? <StrengthPips strength={f.strength} /> : null}
                                          </div>
                                          <span className="line-clamp-2 text-sm font-medium text-primary">{f.risk}</span>
                                          <div className="flex items-center gap-2 font-mono text-[10px] text-muted">
                                              <span>
                                                  {f.files.length} {f.files.length === 1 ? "file" : "files"}
                                              </span>
                                              <span className="text-border">·</span>
                                              <span>{findingSignalCount(f)} signals</span>
                                              <span className="flex-1" />
                                              <span className={TONE_TEXT[fmeta.tone]}>{fmeta.delta}</span>
                                          </div>
                                      </button>
                                  );
                              })
                            : null}
                    </div>
                );
            })}
        </div>
    );
}
