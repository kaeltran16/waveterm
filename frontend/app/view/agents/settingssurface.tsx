// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getSettingsKeyAtom } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { useState } from "react";
import type { AgentsViewModel, SurfaceKey } from "./agents";
import { coerceFontSize, startupSurfaceAtom, startupSurfaceOptions } from "./cockpitprefsstore";
import { RUNTIME_FLAGS, type Runtime } from "./launch";
import { naFlagsAtom, naRememberFlagsAtom } from "./naflagsstore";
import { ITEMS } from "./navrail";
import { railVisibleAtom } from "./railstore";

const LABEL: Record<SurfaceKey, string> = Object.fromEntries(ITEMS.map((i) => [i.key, i.label])) as Record<
    SurfaceKey,
    string
>;

// Runtimes with a flag catalog (terminal has none) — the flag editor only lists these.
const FLAG_RUNTIMES: { id: Runtime; name: string }[] = [
    { id: "claude", name: "Claude Code" },
    { id: "codex", name: "Codex" },
    { id: "antigravity", name: "Antigravity" },
];

export function SettingsSurface({ model }: { model: AgentsViewModel }) {
    return (
        <div className="flex h-full flex-col overflow-y-auto bg-background px-8 py-6">
            <div className="mb-6">
                <h1 className="text-[19px] font-bold text-primary">Settings</h1>
                <p className="mt-1 text-[12.5px] text-muted">Cockpit preferences and New Agent defaults.</p>
            </div>
            <div className="flex max-w-[640px] flex-col gap-7">
                <GeneralSection />
                <NewAgentDefaultsSection />
                <TerminalSection />
                <MemorySection />
            </div>
        </div>
    );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div>
            <div className="mb-[11px] font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                {label}
            </div>
            <div className="flex flex-col gap-[14px]">{children}</div>
        </div>
    );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    return (
        <div className="flex items-center gap-4">
            <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-secondary">{label}</div>
                {hint ? <div className="mt-0.5 text-[11.5px] text-muted">{hint}</div> : null}
            </div>
            <div className="shrink-0">{children}</div>
        </div>
    );
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            onClick={onToggle}
            className={cn(
                "relative h-[20px] w-[34px] shrink-0 cursor-pointer rounded-full transition-colors",
                on ? "bg-accent" : "bg-edge-strong"
            )}
        >
            <span
                className={cn(
                    "absolute top-[3px] h-[14px] w-[14px] rounded-full bg-background transition-all",
                    on ? "left-[18px]" : "left-[2px]"
                )}
            />
        </button>
    );
}

function GeneralSection() {
    const [startup, setStartup] = useAtom(startupSurfaceAtom);
    const [railVisible, setRailVisible] = useAtom(railVisibleAtom);
    const options = startupSurfaceOptions();
    return (
        <Section label="General">
            <Row label="Startup surface" hint="Which surface opens when the app launches.">
                <div className="flex flex-wrap justify-end gap-[6px]">
                    {options.map((k) => (
                        <button
                            key={k}
                            type="button"
                            onClick={() => setStartup(k)}
                            className={cn(
                                "cursor-pointer rounded-[7px] border px-[10px] py-[5px] text-[12px] font-medium",
                                startup === k
                                    ? "border-accent-700 bg-accentbg text-primary"
                                    : "border-edge-mid bg-surface text-muted-foreground hover:border-edge-strong"
                            )}
                        >
                            {LABEL[k] ?? k}
                        </button>
                    ))}
                </div>
            </Row>
            <Row label="Show details rail by default" hint="The per-agent git/details rail on the Agent surface.">
                <Toggle on={railVisible} onToggle={() => setRailVisible((v) => !v)} />
            </Row>
        </Section>
    );
}

function NewAgentDefaultsSection() {
    const [flags, setFlags] = useAtom(naFlagsAtom);
    const [remember, setRemember] = useAtom(naRememberFlagsAtom);
    const [runtime, setRuntime] = useState<Runtime>("claude");
    const catalog = RUNTIME_FLAGS[runtime];
    const runtimeFlags = flags[runtime] ?? {};
    const setFlag = (id: string, on: boolean) =>
        setFlags((prev) => ({ ...prev, [runtime]: { ...prev[runtime], [id]: on } }));
    return (
        <Section label="New Agent defaults">
            <Row
                label="Remember flags"
                hint="Reuse the enabled flags for every new agent (instead of clearing after launch)."
            >
                <Toggle on={remember} onToggle={() => setRemember((v) => !v)} />
            </Row>
            <div className="flex gap-[6px]">
                {FLAG_RUNTIMES.map((r) => (
                    <button
                        key={r.id}
                        type="button"
                        onClick={() => setRuntime(r.id)}
                        className={cn(
                            "cursor-pointer rounded-[7px] border px-[11px] py-[6px] text-[12px] font-medium",
                            runtime === r.id
                                ? "border-accent-700 bg-accentbg text-primary"
                                : "border-edge-mid bg-surface text-muted-foreground hover:border-edge-strong"
                        )}
                    >
                        {r.name}
                    </button>
                ))}
            </div>
            <div className="flex flex-col gap-[7px] rounded-[10px] border border-edge-mid bg-surface p-[11px]">
                {catalog.map((f) => {
                    const on = !!runtimeFlags[f.id];
                    return (
                        <button
                            key={f.id}
                            type="button"
                            onClick={() => setFlag(f.id, !on)}
                            className="flex w-full cursor-pointer items-center gap-[10px] rounded-[7px] px-[8px] py-[6px] text-left hover:bg-surface-hover"
                        >
                            <span
                                className={cn(
                                    "flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px] border font-mono text-[9px] font-bold text-background",
                                    on ? "border-accent bg-accent" : "border-edge-strong"
                                )}
                            >
                                {on ? "✓" : ""}
                            </span>
                            <span
                                className={cn(
                                    "shrink-0 font-mono text-[11.5px] font-semibold",
                                    on ? "text-accent-soft" : "text-muted-foreground"
                                )}
                            >
                                {f.flag}
                            </span>
                            <span className="flex-1 truncate text-right text-[11px] text-muted">{f.desc}</span>
                        </button>
                    );
                })}
            </div>
        </Section>
    );
}

function TerminalSection() {
    const stored = useAtomValue(getSettingsKeyAtom("term:fontsize"));
    const [draft, setDraft] = useState<string>(stored != null ? String(stored) : "");
    const commit = () => {
        const n = coerceFontSize(draft);
        if (n == null) {
            setDraft(stored != null ? String(stored) : "");
            return;
        }
        setDraft(String(n));
        void RpcApi.SetConfigCommand(TabRpcClient, { "term:fontsize": n });
    };
    return (
        <Section label="Terminal">
            <Row label="Font size" hint="Default font size for agent terminals (px).">
                <input
                    type="number"
                    min={6}
                    max={48}
                    value={draft}
                    placeholder="12"
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            (e.target as HTMLInputElement).blur();
                        }
                    }}
                    className="w-[72px] rounded-[8px] border border-edge-mid bg-surface px-3 py-[7px] text-right font-mono text-[13px] text-primary outline-none focus:border-accent-700"
                />
            </Row>
        </Section>
    );
}

function MemorySection() {
    const stored = useAtomValue(getSettingsKeyAtom("memory:vaultpath"));
    const [draft, setDraft] = useState<string>(stored ?? "");
    const [saved, setSaved] = useState(false);
    const dirty = draft !== (stored ?? "");
    const commit = () => {
        void RpcApi.SetConfigCommand(TabRpcClient, { "memory:vaultpath": draft.trim() }).then(() => {
            setSaved(true);
        });
    };
    return (
        <Section label="Memory">
            <div>
                <div className="text-[13px] font-medium text-secondary">Vault path</div>
                <div className="mt-0.5 text-[11.5px] text-muted">Folder the Memory surface reads and writes.</div>
                <div className="mt-[9px] flex items-center gap-2">
                    <input
                        type="text"
                        value={draft}
                        placeholder="~/vault"
                        onChange={(e) => {
                            setDraft(e.target.value);
                            setSaved(false);
                        }}
                        className="min-w-0 flex-1 rounded-[8px] border border-edge-mid bg-surface px-3 py-[7px] font-mono text-[12.5px] text-primary outline-none focus:border-accent-700"
                    />
                    <button
                        type="button"
                        onClick={commit}
                        disabled={!dirty}
                        className={cn(
                            "shrink-0 rounded-[8px] px-[15px] py-[7px] text-[12.5px] font-semibold",
                            dirty
                                ? "cursor-pointer bg-accent text-background hover:bg-accenthover"
                                : "cursor-not-allowed bg-surface text-muted"
                        )}
                    >
                        {saved && !dirty ? "Saved" : "Save"}
                    </button>
                </div>
            </div>
        </Section>
    );
}
