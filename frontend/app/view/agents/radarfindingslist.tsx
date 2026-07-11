// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useState } from "react";
import { DEFAULT_OPEN_GROUPS, GROUP_ORDER, groupFindings, type RadarGroup } from "./radarmodel";

const GROUP_LABEL: Record<RadarGroup, string> = {
    new: "New",
    recurring: "Recurring",
    nolonger: "No longer detected",
    dismissed: "Dismissed",
    suppressed: "Suppressed",
};

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
        <div className="flex w-[340px] shrink-0 flex-col overflow-y-auto border-r border-border">
            {GROUP_ORDER.map((g) => {
                const items = grouped[g];
                if (items.length === 0) {
                    return null;
                }
                const isOpen = open.has(g);
                return (
                    <div key={g}>
                        <button
                            type="button"
                            onClick={() => toggle(g)}
                            className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted"
                        >
                            <span>
                                {GROUP_LABEL[g]} <span className="text-muted-foreground">({items.length})</span>
                            </span>
                            <span className="font-mono">{isOpen ? "−" : "+"}</span>
                        </button>
                        {isOpen
                            ? items.map((f) => (
                                  <button
                                      key={f.id}
                                      type="button"
                                      onClick={() => onSelect(f.id)}
                                      className={cn(
                                          "flex w-full flex-col gap-0.5 border-l-2 px-3 py-2 text-left",
                                          selectedId === f.id
                                              ? "border-accent bg-accent/10"
                                              : "border-transparent hover:bg-surface"
                                      )}
                                  >
                                      <span className="line-clamp-2 text-sm text-primary">{f.risk}</span>
                                      <span className="text-xs text-muted-foreground">
                                          {f.subsystem} · {f.severity} · {f.strength}
                                      </span>
                                  </button>
                              ))
                            : null}
                    </div>
                );
            })}
        </div>
    );
}
