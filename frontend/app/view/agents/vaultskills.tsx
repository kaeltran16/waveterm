// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Vault's skills collection (Wave-vault-tab.dc.html): one row per canonical skill, one column per
// harness that scans a fixed skills directory, so the drift between the vault and the harnesses reads
// at a glance. A harness with no fixed directory (pi) gets no column — it reads an explicit list of
// paths from its own settings, reported as a note under the table instead.

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { memSearchAtom } from "./memstore";
import { vaultHarnessesAtom, vaultSelectedSkillAtom, vaultSkillColumnsAtom, vaultSkillsAtom } from "./vaultstore";

// Cell state -> tone. Never color alone: the cell also spells the state out.
const STATE_TONE: Record<string, string> = {
    linked: "text-success",
    conflict: "text-error",
    pending: "text-muted",
    absent: "text-ink-faint",
};

const STATE_LABEL: Record<string, string> = {
    linked: "linked",
    conflict: "conflict",
    pending: "will link",
    absent: "—",
};

export function VaultSkills() {
    const skills = useAtomValue(vaultSkillsAtom);
    const columns = useAtomValue(vaultSkillColumnsAtom);
    const selected = useAtomValue(vaultSelectedSkillAtom);
    const harnesses = useAtomValue(vaultHarnessesAtom);
    const search = useAtomValue(memSearchAtom).trim().toLowerCase();

    const rows = search
        ? skills.filter((s) => `${s.name} ${s.description ?? ""}`.toLowerCase().includes(search))
        : skills;
    // Only pi carries a note today, but read it off the rows rather than naming a runtime here.
    const notes = harnesses.filter((h) => h.present && h.note).map((h) => `${h.label}: ${h.note}`);
    const grid = { gridTemplateColumns: `minmax(200px,1fr) repeat(${columns.length}, 96px)` };

    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
            <div
                style={grid}
                className="grid flex-none gap-[10px] border-b border-edge-faint px-[24px] py-[10px] font-mono text-[9.5px] font-bold uppercase tracking-[0.1em] text-feed-label"
            >
                <span>Skill</span>
                {columns.map((c) => (
                    <span key={c.runtime} className={cn(!c.present && "text-ink-faint")}>
                        {c.label}
                        {!c.present && " (absent)"}
                    </span>
                ))}
            </div>
            {rows.length === 0 ? (
                <div className="px-[24px] py-[16px] text-[12.5px] text-ink-faint">
                    {skills.length === 0
                        ? "No skills in the vault yet. A directory under the vault's skills root becomes a canonical skill."
                        : "No skills match."}
                </div>
            ) : (
                rows.map((s) => (
                    <div
                        key={s.name}
                        style={grid}
                        onClick={() => globalStore.set(vaultSelectedSkillAtom, s.name)}
                        data-vault-skill-row={s.name}
                        className={cn(
                            "grid cursor-pointer items-center gap-[10px] border-b border-edge-faint px-[24px] py-[11px]",
                            selected === s.name ? "bg-surface" : "hover:bg-surface/60"
                        )}
                    >
                        <div className="flex min-w-0 items-baseline gap-[10px]">
                            <span className="flex-none whitespace-nowrap font-mono text-[12.5px] font-medium text-primary">
                                {s.name}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[11px] text-ink-mid">{s.description}</span>
                        </div>
                        {columns.map((c) => {
                            const state = s.states?.[c.runtime] ?? "absent";
                            return (
                                <span
                                    key={c.runtime}
                                    className={cn(
                                        "font-mono text-[11px] font-medium",
                                        STATE_TONE[state] ?? "text-muted"
                                    )}
                                >
                                    {STATE_LABEL[state] ?? state}
                                </span>
                            );
                        })}
                    </div>
                ))
            )}
            {notes.map((n) => (
                <div key={n} className="px-[24px] py-[12px] font-mono text-[11px] text-ink-faint">
                    {n}
                </div>
            ))}
        </div>
    );
}
