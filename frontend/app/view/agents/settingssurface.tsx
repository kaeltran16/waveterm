// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atoms, getSettingsKeyAtom } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { useState } from "react";
import type { AgentsViewModel, SurfaceKey } from "./agents";
import { coerceFontSize, coerceScrollback, coerceTransparency, startupSurfaceAtom, startupSurfaceOptions } from "./cockpitprefsstore";
import { DEFAULT_TERM_FONT, MONO_FONTS, SANS_FONTS, stackOf } from "./fonts";
import { fontMonoAtom, fontSansAtom } from "./fontstore";
import { RUNTIME_FLAGS, type Runtime } from "./launch";
import { naFlagsAtom, naRememberFlagsAtom } from "./naflagsstore";
import { ITEMS } from "./navrail";
import { railVisibleAtom } from "./railstore";
import { ACCENT_SWATCHES, activePalette, colorOf, PICKER_THEMES, type OverrideRole } from "./themes";
import { themeOverridesAtom, themePresetAtom } from "./themestore";

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

export function SettingsSurface(_props: { model: AgentsViewModel }) {
    return (
        <div className="flex h-full flex-col overflow-y-auto bg-background px-10 py-9">
            <div className="mx-auto w-full max-w-[720px]">
                <h1 className="text-[26px] font-extrabold tracking-[-0.025em] text-primary">Settings</h1>
                <p className="mb-9 mt-1.5 text-[13.5px] text-muted">
                    Cockpit preferences, appearance, and New Agent defaults.
                </p>
                <AppearanceSection />
                <SectionGap />
                <FontsSection />
                <SectionGap />
                <GeneralSection />
                <SectionGap />
                <NewAgentDefaultsSection />
                <SectionGap />
                <TerminalSection />
                <SectionGap />
                <MemorySection />
            </div>
        </div>
    );
}

function SectionGap() {
    return <div className="h-[34px]" />;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
    return (
        <div className="mb-4 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted">{children}</div>
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
                "relative mt-0.5 h-[23px] w-[42px] shrink-0 cursor-pointer rounded-full transition-colors",
                on ? "bg-accent" : "bg-surface-selected"
            )}
        >
            <span
                className={cn(
                    "absolute top-[2px] h-[19px] w-[19px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.4)] transition-all",
                    on ? "left-[21px]" : "left-[2px]"
                )}
            />
        </button>
    );
}

function CheckIcon() {
    return (
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4">
            <path d="M3.5 8.5 7 12l6-7.5" />
        </svg>
    );
}

function Swatch({ color }: { color: string }) {
    return <span className="h-[13px] w-[13px] rounded-[4px]" style={{ background: color }} />;
}

// mirror termutil.ts DefaultTermTheme (inlined to avoid pulling xterm into the settings bundle)
const DEFAULT_TERM_THEME = "default-dark";

// Labeled settings row: title + description left, control right. Rows stack directly on the page
// (flat, no card — matching the design); the first row drops its top divider.
function Row({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
    return (
        <div className="flex items-center justify-between gap-5 border-t border-edge-faint py-3 first:border-t-0">
            <div className="min-w-0 flex-1">
                <div className="mb-0.5 text-[14px] font-semibold text-primary">{title}</div>
                <div className="text-[12.5px] text-muted">{desc}</div>
            </div>
            <div className="flex flex-none items-center">{children}</div>
        </div>
    );
}

// Segmented pill group. Labels render in the UI font (matching the design).
function Segmented<T extends string>({
    options,
    value,
    onChange,
}: {
    options: { id: T; label: string }[];
    value: T;
    onChange: (id: T) => void;
}) {
    return (
        <div className="flex overflow-hidden rounded-[9px] border border-edge-mid bg-surface-raised">
            {options.map((o, i) => (
                <button
                    key={o.id}
                    type="button"
                    onClick={() => onChange(o.id)}
                    className={cn(
                        "cursor-pointer whitespace-nowrap px-3 py-[7px] text-[12.5px] font-semibold transition-colors",
                        i > 0 && "border-l border-border",
                        value === o.id ? "bg-accentbg text-accent" : "text-secondary hover:text-primary"
                    )}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

// +/- stepper. onStep receives -1 or 1; the caller applies its own step size.
function Stepper({ value, onStep, ariaLabel }: { value: number; onStep: (dir: -1 | 1) => void; ariaLabel: string }) {
    return (
        <div className="flex items-center overflow-hidden rounded-[9px] border border-edge-mid bg-surface-raised">
            <button
                type="button"
                aria-label={`Decrease ${ariaLabel}`}
                onClick={() => onStep(-1)}
                className="h-[34px] w-[34px] cursor-pointer border-r border-border text-[17px] font-semibold text-secondary hover:bg-surface-hover"
            >
                −
            </button>
            <div className="min-w-[56px] px-2 text-center font-mono text-[13px] text-primary">{value}</div>
            <button
                type="button"
                aria-label={`Increase ${ariaLabel}`}
                onClick={() => onStep(1)}
                className="h-[34px] w-[34px] cursor-pointer border-l border-border text-[17px] font-semibold text-secondary hover:bg-surface-hover"
            >
                +
            </button>
        </div>
    );
}

// Fonts section: Interface (--font-sans) and Code (--font-mono) are cockpit CSS-var overrides; Terminal
// is the backend term:fontfamily config key. Flat rows with dividers (no card), matching the design.
function FontsSection() {
    const [sans, setSans] = useAtom(fontSansAtom);
    const [mono, setMono] = useAtom(fontMonoAtom);
    const termFontStack = (useAtomValue(getSettingsKeyAtom("term:fontfamily")) as string) ?? "";
    // terminal font is stored as the full stack string; match it back to a catalog id for the control.
    const termFontId = MONO_FONTS.find((f) => f.stack === termFontStack)?.id ?? DEFAULT_TERM_FONT;
    const setTermFont = (id: string) =>
        void RpcApi.SetConfigCommand(TabRpcClient, { "term:fontfamily": stackOf(MONO_FONTS, id) });
    const sansOpts = SANS_FONTS.map((f) => ({ id: f.id, label: f.label }));
    const monoOpts = MONO_FONTS.map((f) => ({ id: f.id, label: f.label }));
    return (
        <div>
            <SectionLabel>Fonts</SectionLabel>
            <div>
                <Row title="Interface font" desc="App-wide UI text — nav, panels, labels.">
                    <Segmented options={sansOpts} value={sans} onChange={setSans} />
                </Row>
                <Row title="Code font" desc="Inline code, diffs, and file trees.">
                    <Segmented options={monoOpts} value={mono} onChange={setMono} />
                </Row>
                <Row title="Terminal font" desc="Monospace face inside agent terminals.">
                    <Segmented options={monoOpts} value={termFontId} onChange={setTermFont} />
                </Row>
            </div>
        </div>
    );
}

function AppearanceSection() {
    const [preset, setPreset] = useAtom(themePresetAtom);
    const [overrides, setOverrides] = useAtom(themeOverridesAtom);
    const palette = activePalette(preset);
    const isCustom = Object.keys(overrides).length > 0;
    const activeName = PICKER_THEMES.find((t) => t.id === preset)?.name ?? "Midnight";
    const setOverride = (role: OverrideRole, hex: string) => setOverrides((prev) => ({ ...prev, [role]: hex }));
    const selectPreset = (id: string) => {
        setPreset(id);
        setOverrides({});
    };
    const accent = colorOf(palette, overrides, "accent");
    const statusRoles: { role: OverrideRole; label: string; desc: string }[] = [
        { role: "success", label: "Working / accept", desc: "Live agents, accepted diffs" },
        { role: "warning", label: "Asking / attention", desc: "Awaiting your reply" },
        { role: "error", label: "Blocked / reject", desc: "Errors, discarded changes" },
    ];
    return (
        <div>
            <SectionLabel>Appearance</SectionLabel>
            <div className="mb-[22px]">
                <div className="text-[14px] font-semibold text-primary">Theme</div>
                <div className="mb-3.5 mt-0.5 text-[12.5px] text-muted">
                    Base palette for every surface.{" "}
                    <span className="font-semibold text-accent">
                        {isCustom ? `Custom · based on ${activeName}` : activeName}
                    </span>
                </div>
                <div className="grid grid-cols-4 gap-2.5">
                    {PICKER_THEMES.map((t) => {
                        const on = t.id === preset;
                        return (
                            <button
                                key={t.id}
                                type="button"
                                onClick={() => selectPreset(t.id)}
                                className={cn(
                                    "flex cursor-pointer items-center gap-2.5 rounded-[11px] border p-[10px] text-left transition-colors",
                                    on ? "border-accent-700 bg-surface-hover" : "border-border hover:border-edge-strong"
                                )}
                            >
                                <div className="flex flex-none flex-col gap-[3px]">
                                    <div className="flex gap-[3px]">
                                        <Swatch color={t.palette.bg} />
                                        <Swatch color={t.palette.surface} />
                                    </div>
                                    <div className="flex gap-[3px]">
                                        <Swatch color={t.palette.accent} />
                                        <Swatch color={t.palette.success} />
                                    </div>
                                </div>
                                <span
                                    className={cn(
                                        "min-w-0 flex-1 truncate text-[12px] font-semibold",
                                        on ? "text-primary" : "text-secondary"
                                    )}
                                >
                                    {t.name}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>

            <div className="rounded-[14px] border border-border bg-surface p-[18px]">
                <div className="mb-4 flex items-center justify-between">
                    <div>
                        <div className="text-[13.5px] font-semibold text-primary">Custom colors</div>
                        <div className="text-[12px] text-muted">
                            Override any role. Tints and gradients recompute automatically.
                        </div>
                    </div>
                    {isCustom ? (
                        <button
                            type="button"
                            onClick={() => setOverrides({})}
                            className="cursor-pointer rounded-[8px] border border-edge-mid px-[11px] py-1.5 text-[12px] font-semibold text-secondary hover:border-edge-strong hover:text-primary"
                        >
                            Reset to preset
                        </button>
                    ) : null}
                </div>

                <div className="flex items-center gap-3.5 border-t border-edge-faint py-[11px]">
                    <div className="min-w-0 flex-1">
                        <div className="text-[12.5px] font-semibold text-primary">Accent</div>
                        <div className="text-[11.5px] text-muted">Primary actions, active nav, links</div>
                    </div>
                    <div className="flex flex-none items-center gap-[7px]">
                        {ACCENT_SWATCHES.map((hex) => (
                            <button
                                key={hex}
                                type="button"
                                title={hex}
                                onClick={() => setOverride("accent", hex)}
                                className="h-[22px] w-[22px] cursor-pointer rounded-[6px] border-2 p-0"
                                style={{
                                    background: hex,
                                    borderColor:
                                        hex.toLowerCase() === accent.toLowerCase()
                                            ? "var(--color-primary)"
                                            : "transparent",
                                }}
                            />
                        ))}
                        <label
                            title="Custom hex"
                            className="relative flex h-[22px] w-[22px] flex-none cursor-pointer items-center justify-center overflow-hidden rounded-[6px] border border-edge-mid"
                        >
                            <span className="pointer-events-none absolute font-mono text-[12px] font-bold text-muted">
                                +
                            </span>
                            <input
                                type="color"
                                value={accent}
                                onChange={(e) => setOverride("accent", e.target.value)}
                                className="h-[36px] w-[36px] cursor-pointer opacity-0"
                            />
                        </label>
                    </div>
                </div>

                {statusRoles.map((r) => {
                    const hex = colorOf(palette, overrides, r.role);
                    return (
                        <div key={r.role} className="flex items-center gap-3.5 border-t border-edge-faint py-[11px]">
                            <div className="min-w-0 flex-1">
                                <div className="text-[12.5px] font-semibold text-primary">{r.label}</div>
                                <div className="text-[11.5px] text-muted">{r.desc}</div>
                            </div>
                            <div className="flex flex-none items-center gap-[9px]">
                                <span className="font-mono text-[11px] text-muted">{hex}</span>
                                <label className="block h-[24px] w-[34px] cursor-pointer overflow-hidden rounded-[7px] border border-edge-mid">
                                    <input
                                        type="color"
                                        value={hex}
                                        onChange={(e) => setOverride(r.role, e.target.value)}
                                        className="m-[-5px] h-[34px] w-[44px] cursor-pointer"
                                    />
                                </label>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function GeneralSection() {
    const [startup, setStartup] = useAtom(startupSurfaceAtom);
    const [railVisible, setRailVisible] = useAtom(railVisibleAtom);
    const options = startupSurfaceOptions();
    return (
        <div>
            <SectionLabel>General</SectionLabel>
            <div className="mb-5 border-b border-edge-faint pb-5">
                <div className="mb-3">
                    <div className="text-[14px] font-semibold text-primary">Startup surface</div>
                    <div className="mt-0.5 text-[12.5px] text-muted">Which surface opens when the app launches.</div>
                </div>
                <div
                    className="grid overflow-hidden rounded-[9px] border border-edge-mid bg-surface-raised"
                    style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}
                >
                    {options.map((k, i) => (
                        <button
                            key={k}
                            type="button"
                            onClick={() => setStartup(k)}
                            className={cn(
                                "cursor-pointer whitespace-nowrap px-2 py-[9px] text-[12.5px] font-semibold transition-colors",
                                i > 0 && "border-l border-border",
                                startup === k ? "bg-accentbg text-accent" : "text-secondary hover:text-primary"
                            )}
                        >
                            {LABEL[k] ?? k}
                        </button>
                    ))}
                </div>
            </div>
            <div className="flex items-start justify-between gap-5">
                <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-semibold text-primary">Show details rail by default</div>
                    <div className="text-[12.5px] text-muted">The per-agent git/details rail on the Agent surface.</div>
                </div>
                <Toggle on={railVisible} onToggle={() => setRailVisible((v) => !v)} />
            </div>
        </div>
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
        <div>
            <SectionLabel>New Agent Defaults</SectionLabel>
            <div className="mb-[18px] flex items-start justify-between gap-5">
                <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-semibold text-primary">Remember flags</div>
                    <div className="text-[12.5px] text-muted">
                        Reuse the enabled flags for every new agent (instead of clearing after launch).
                    </div>
                </div>
                <Toggle on={remember} onToggle={() => setRemember((v) => !v)} />
            </div>
            <div className="mb-4 flex gap-[7px]">
                {FLAG_RUNTIMES.map((r) => (
                    <button
                        key={r.id}
                        type="button"
                        onClick={() => setRuntime(r.id)}
                        className={cn(
                            "cursor-pointer rounded-[8px] border px-3.5 py-[7px] text-[12.5px] font-semibold transition-colors",
                            runtime === r.id
                                ? "border-accent-700 bg-accentbg text-accent"
                                : "border-edge-mid bg-surface-raised text-secondary hover:border-edge-strong"
                        )}
                    >
                        {r.name}
                    </button>
                ))}
            </div>
            <div className="rounded-[14px] border border-border bg-surface px-4 py-1.5">
                {catalog.map((f, i) => {
                    const on = !!runtimeFlags[f.id];
                    return (
                        <button
                            key={f.id}
                            type="button"
                            onClick={() => setFlag(f.id, !on)}
                            className={cn(
                                "flex w-full cursor-pointer items-center gap-3 py-3 text-left",
                                i > 0 && "border-t border-edge-faint"
                            )}
                        >
                            <span
                                className={cn(
                                    "flex h-[17px] w-[17px] flex-none items-center justify-center rounded-[5px] border-[1.5px] text-background",
                                    on ? "border-accent bg-accent" : "border-edge-strong"
                                )}
                            >
                                {on ? <CheckIcon /> : null}
                            </span>
                            <span
                                className={cn(
                                    "flex-none font-mono text-[12.5px] font-semibold",
                                    on ? "text-accent" : "text-primary"
                                )}
                            >
                                {f.flag}
                            </span>
                            <span className="flex-1" />
                            <span
                                className={cn(
                                    "text-right text-[12px] font-medium",
                                    on ? "text-accent-soft" : "text-muted"
                                )}
                            >
                                {f.desc}
                            </span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

// Custom color-scheme dropdown (matches the design): a trigger showing a 3-swatch preview + name +
// chevron, and a popover of themes with swatches + a check on the active one. A full-viewport backdrop
// button closes it on outside click (no document listeners).
type TermThemeOption = { value: string; label: string; swatch: [string, string, string] };

function TermThemeDropdown({
    options,
    value,
    onChange,
}: {
    options: TermThemeOption[];
    value: string;
    onChange: (v: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const active = options.find((o) => o.value === value);
    return (
        <div className="relative flex-none">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className={cn(
                    "flex min-w-[180px] cursor-pointer items-center gap-2.5 rounded-[9px] border bg-surface-raised px-[11px] py-2 transition-colors",
                    open ? "border-accent-700" : "border-edge-mid hover:border-edge-strong"
                )}
            >
                <span className="flex flex-none gap-0.5">
                    {(active?.swatch ?? ["transparent", "transparent", "transparent"]).map((c, i) => (
                        <span key={i} className="h-2.5 w-2.5 rounded-[3px]" style={{ background: c }} />
                    ))}
                </span>
                <span className="flex-1 whitespace-nowrap text-left text-[12.5px] font-semibold text-primary">
                    {active?.label ?? value}
                </span>
                <span className={cn("font-mono text-[10px] text-muted transition-transform", open && "rotate-180")}>▾</span>
            </button>
            {open ? (
                <>
                    <button
                        type="button"
                        aria-hidden
                        tabIndex={-1}
                        onClick={() => setOpen(false)}
                        className="fixed inset-0 z-10 cursor-default"
                    />
                    <div className="absolute right-0 top-[calc(100%+6px)] z-20 min-w-[220px] rounded-[11px] border border-border bg-surface p-[5px] shadow-[0_12px_34px_rgba(0,0,0,0.5)]">
                        {options.map((o) => {
                            const sel = o.value === value;
                            return (
                                <button
                                    key={o.value}
                                    type="button"
                                    onClick={() => {
                                        onChange(o.value);
                                        setOpen(false);
                                    }}
                                    className={cn(
                                        "flex w-full cursor-pointer items-center gap-2.5 rounded-[8px] px-[9px] py-2 text-left transition-colors hover:bg-surface-hover",
                                        sel ? "bg-surface-raised" : "bg-transparent"
                                    )}
                                >
                                    <span className="flex flex-none gap-0.5">
                                        {o.swatch.map((c, i) => (
                                            <span key={i} className="h-[11px] w-[11px] rounded-[3px]" style={{ background: c }} />
                                        ))}
                                    </span>
                                    <span className="flex-1 whitespace-nowrap text-[12.5px] font-semibold text-primary">
                                        {o.label}
                                    </span>
                                    {sel ? (
                                        <span className="flex-none text-accent">
                                            <CheckIcon />
                                        </span>
                                    ) : null}
                                </button>
                            );
                        })}
                    </div>
                </>
            ) : null}
        </div>
    );
}

function TerminalSection() {
    const fontSize = (useAtomValue(getSettingsKeyAtom("term:fontsize")) as number) ?? 12;
    const scrollback = (useAtomValue(getSettingsKeyAtom("term:scrollback")) as number) ?? 1000;
    const cursorRaw = (useAtomValue(getSettingsKeyAtom("term:cursor")) as string) ?? "block";
    const cursorBlink = (useAtomValue(getSettingsKeyAtom("term:cursorblink")) as boolean) ?? false;
    const copyOnSelect = (useAtomValue(getSettingsKeyAtom("term:copyonselect")) as boolean) ?? false;
    const transparency = (useAtomValue(getSettingsKeyAtom("term:transparency")) as number) ?? 0.5;
    const themeName = (useAtomValue(getSettingsKeyAtom("term:theme")) as string) ?? DEFAULT_TERM_THEME;
    const fullConfig = useAtomValue(atoms.fullConfigAtom);

    // SetConfigCommand's data param is a typed settings map; a dynamic-key patch needs the cast.
    const write = (patch: Record<string, unknown>) =>
        void RpcApi.SetConfigCommand(TabRpcClient, patch as Parameters<typeof RpcApi.SetConfigCommand>[1]);

    const cursor = cursorRaw === "bar" || cursorRaw === "underline" ? cursorRaw : "block";

    // real backend term themes, sorted by display order; 3-swatch preview from bg / blue / green.
    const termthemes = fullConfig?.termthemes ?? {};
    const themeOptions: TermThemeOption[] = Object.keys(termthemes)
        .sort((a, b) => (termthemes[a]["display:order"] ?? 0) - (termthemes[b]["display:order"] ?? 0))
        .map((k) => {
            const t = termthemes[k];
            return { value: k, label: t["display:name"] ?? k, swatch: [t.background, t.blue, t.green] };
        });

    const stepFontSize = (dir: -1 | 1) => {
        const next = coerceFontSize(String(fontSize + dir));
        if (next != null && next !== fontSize) write({ "term:fontsize": next });
    };
    const stepScrollback = (dir: -1 | 1) => {
        const next = coerceScrollback(String(Math.max(100, scrollback + dir * 250)));
        if (next != null && next !== scrollback) write({ "term:scrollback": next });
    };

    return (
        <div>
            <SectionLabel>Terminal</SectionLabel>
            <div>
                <Row title="Font size" desc="Default font size for agent terminals (px).">
                    <Stepper value={fontSize} onStep={stepFontSize} ariaLabel="font size" />
                </Row>
                <Row title="Cursor style" desc="Shape of the terminal caret.">
                    <Segmented
                        options={[
                            { id: "block", label: "Block" },
                            { id: "bar", label: "Bar" },
                            { id: "underline", label: "Underline" },
                        ]}
                        value={cursor}
                        onChange={(v) => write({ "term:cursor": v })}
                    />
                </Row>
                <Row title="Cursor blink" desc="Pulse the caret when the terminal is focused.">
                    <Toggle on={cursorBlink} onToggle={() => write({ "term:cursorblink": !cursorBlink })} />
                </Row>
                <Row title="Scrollback" desc="Lines of history kept per terminal.">
                    <Stepper value={scrollback} onStep={stepScrollback} ariaLabel="scrollback" />
                </Row>
                <Row title="Copy on select" desc="Copy highlighted text to the clipboard automatically.">
                    <Toggle on={copyOnSelect} onToggle={() => write({ "term:copyonselect": !copyOnSelect })} />
                </Row>
                <Row title="Transparency" desc="Terminal background opacity — higher is more see-through.">
                    <div className="flex items-center gap-3">
                        <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            value={transparency}
                            onChange={(e) => write({ "term:transparency": coerceTransparency(Number(e.target.value)) })}
                            style={{ accentColor: "var(--color-accent)" }}
                            className="w-[160px] cursor-pointer"
                        />
                        <span className="w-10 flex-none text-right font-mono text-[12.5px] text-primary">
                            {transparency.toFixed(2)}
                        </span>
                    </div>
                </Row>
                <Row title="Color scheme" desc="ANSI palette used inside agent terminals.">
                    <TermThemeDropdown
                        options={themeOptions}
                        value={themeName}
                        onChange={(v) => write({ "term:theme": v })}
                    />
                </Row>
            </div>
        </div>
    );
}

function MemorySection() {
    const stored = useAtomValue(getSettingsKeyAtom("memory:vaultpath"));
    const [draft, setDraft] = useState<string>(stored ?? "");
    const [saved, setSaved] = useState(false);
    const dirty = draft !== (stored ?? "");
    const showSaved = saved && !dirty;
    const commit = () => {
        void RpcApi.SetConfigCommand(TabRpcClient, { "memory:vaultpath": draft.trim() }).then(() => setSaved(true));
    };
    return (
        <div>
            <SectionLabel>Memory</SectionLabel>
            <div className="text-[14px] font-semibold text-primary">Vault path</div>
            <div className="mb-3 mt-0.5 text-[12.5px] text-muted">Folder the Memory surface reads and writes.</div>
            <div className="flex gap-2.5">
                <input
                    type="text"
                    value={draft}
                    placeholder="~/vault"
                    onChange={(e) => {
                        setDraft(e.target.value);
                        setSaved(false);
                    }}
                    className="min-w-0 flex-1 rounded-[9px] border border-edge-mid bg-surface-raised px-3.5 py-2.5 font-mono text-[13px] text-primary outline-none focus:border-accent-700"
                />
                <button
                    type="button"
                    onClick={commit}
                    className={cn(
                        "shrink-0 rounded-[9px] border px-[18px] text-[13px] font-semibold transition-colors",
                        showSaved
                            ? "border-success/40 bg-success/[0.14] text-success-soft"
                            : "border-edge-mid bg-surface-raised text-secondary hover:border-edge-strong"
                    )}
                >
                    {showSaved ? "Saved ✓" : "Save"}
                </button>
            </div>
        </div>
    );
}
