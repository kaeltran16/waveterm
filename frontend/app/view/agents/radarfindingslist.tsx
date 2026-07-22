// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { composerReveal } from "@/app/element/motiontokens";
import { useSurfaceListNav, type ListNavController } from "@/app/store/keybindings/listnav";
import { cn } from "@/util/util";
import { ChevronDown, ChevronRight } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import {
    DEFAULT_OPEN_GROUPS,
    findingMode,
    findingSignalCount,
    groupFindings,
    groupMeta,
    GROUP_ORDER,
    investigationBadge,
    isMutedGroup,
    MODE_META,
    strengthPips,
    type RadarGroup,
} from "./radarmodel";
import { modeBadge, severityPill, TONE_DOT, TONE_TEXT } from "./radarstyles";

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
    onActivate,
}: {
    findings: RadarFinding[];
    selectedId: string | undefined;
    onSelect: (id: string) => void;
    onActivate?: () => void; // list-nav Enter: start the selected finding's investigation
}) {
    const grouped = useMemo(() => groupFindings(findings), [findings]);
    const [open, setOpen] = useState<Set<RadarGroup>>(() => new Set(DEFAULT_OPEN_GROUPS));
    const toggle = (g: RadarGroup) =>
        setOpen((prev) => {
            const next = new Set(prev);
            next.has(g) ? next.delete(g) : next.add(g);
            return next;
        });
    // publish only the *rendered* order (open groups) for global j/k list-nav, so the cursor never lands
    // on a row hidden inside a collapsed group. cursor==selection. (listnav.ts)
    const navIds = useMemo(
        () => GROUP_ORDER.filter((g) => open.has(g)).flatMap((g) => grouped[g].map((f) => f.id)),
        [grouped, open]
    );
    const listNav = useMemo<ListNavController>(
        () => ({ surface: "radar", navigableIds: navIds, cursorId: selectedId, setCursor: onSelect, activate: onActivate }),
        [navIds, selectedId, onSelect, onActivate]
    );
    useSurfaceListNav(listNav);

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
                        <AnimatePresence initial={false}>
                            {isOpen ? (
                                <motion.div
                                    key="items"
                                    variants={composerReveal}
                                    initial="initial"
                                    animate="animate"
                                    exit="exit"
                                    className="overflow-hidden"
                                >
                                    {items.map((f) => {
                                  const active = selectedId === f.id;
                                  const muted = isMutedGroup(f.group);
                                  const fmeta = groupMeta(f.group);
                                  const badge = investigationBadge(f);
                                  return (
                                      <button
                                          key={f.id}
                                          type="button"
                                          onClick={() => onSelect(f.id)}
                                          className={cn(
                                              "relative flex w-full flex-col gap-2 border-l-2 px-3.5 py-2.5 text-left transition-colors duration-150",
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
                                              {findingMode(f) !== "correctness" ? (
                                                  <span
                                                      className={cn(
                                                          "shrink-0 rounded border px-1 py-px text-[8px] font-bold uppercase tracking-wide",
                                                          modeBadge(findingMode(f))
                                                      )}
                                                  >
                                                      {MODE_META[findingMode(f)].short}
                                                  </span>
                                              ) : null}
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
                                              {badge ? (
                                                  <span
                                                      className={cn(
                                                          badge === "still-detected"
                                                              ? TONE_TEXT.recurring
                                                              : badge === "investigating"
                                                                ? "text-accent-soft"
                                                                : TONE_TEXT.nolonger
                                                      )}
                                                  >
                                                      {badge === "still-detected"
                                                          ? "still detected"
                                                          : badge === "investigating"
                                                            ? "investigating"
                                                            : "investigated"}
                                                  </span>
                                              ) : null}
                                              <span className="flex-1" />
                                              <span className={TONE_TEXT[fmeta.tone]}>{fmeta.delta}</span>
                                          </div>
                                      </button>
                                  );
                                    })}
                                </motion.div>
                            ) : null}
                        </AnimatePresence>
                    </div>
                );
            })}
        </div>
    );
}
