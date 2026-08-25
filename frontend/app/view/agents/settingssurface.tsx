// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { MOTION } from "@/app/element/motiontokens";
import { getSettingsKeyAtom } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { ChevronRight, Folder } from "lucide-react";
import { motion, MotionConfig, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import type { AgentsViewModel, SurfaceKey } from "./agents";
import {
    coerceFontSize,
    coerceScrollback,
    startupSurfaceAtom,
    startupSurfaceOptions,
    vaultPathError,
} from "./cockpitprefsstore";
import { DEFAULT_TERM_FONT, MONO_FONTS, SANS_FONTS, stackOf } from "./fonts";
import { fontMonoAtom, fontSansAtom } from "./fontstore";
import { harnessPickerItems } from "./harnesspicker";
import { harnessPreferenceAtom, setPreferredRoute } from "./harnessstore";
import { RoutePicker } from "./routepicker";
import { RUNTIME_FLAGS, type Runtime } from "./launch";
import { naFlagsAtom, naRememberFlagsAtom } from "./naflagsstore";
import { ITEMS } from "./navrail";
import { railVisibleAtom } from "./railstore";
import { SETTINGS_SECTION_EMBEDDINGS, takePendingSettingsSection } from "./settingsstore";
import { SurfaceHeader } from "./surfacescaffold";
import { ACCENT_SWATCHES, activePalette, colorOf, THEMES, type OverrideRole } from "./themes";
import { themeOverridesAtom, themePresetAtom } from "./themestore";

const LABEL: Record<SurfaceKey, string> = Object.fromEntries(ITEMS.map((i) => [i.key, i.label])) as Record<
    SurfaceKey,
    string
>;

// Runtimes the flag editor lists. Terminal stays out (it isn't an agent); pi is included even though
// its catalog is empty so its no-flags state renders in the editor instead of the row vanishing.
const FLAG_RUNTIMES: { id: Runtime; name: string }[] = [
    { id: "claude", name: "Claude Code" },
    { id: "codex", name: "Codex" },
    { id: "opencode", name: "OpenCode" },
    { id: "pi", name: "Pi" },
];

export function SettingsSurface(_props: { model: AgentsViewModel }) {
    const reduce = useReducedMotion();
    // Deep-link landing. The sections are a flat scroll with no routes and embeddings is the last of seven,
    // so a bare surface switch lands at the top of a long page — an escort in name only.
    useEffect(() => {
        const want = takePendingSettingsSection();
        if (want == null) {
            return;
        }
        document.getElementById(want)?.scrollIntoView({ block: "start", behavior: "smooth" });
    }, []);
    return (
        <MotionConfig reducedMotion="user">
            <div className="flex h-full flex-col overflow-y-auto bg-background px-10 py-9">
                <motion.div
                    className="mx-auto w-full max-w-[720px]"
                    initial={reduce ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: MOTION.durMacro, ease: MOTION.easeFluid }}
                >
                    <div className="mb-9 -mx-[28px]">
                        <SurfaceHeader
                            title="Settings"
                            subtitle="Cockpit preferences, appearance, and New Agent defaults."
                            border={false}
                        />
                    </div>
                    <AppearanceSection />
                    <SectionGap />
                    <FontsSection />
                    <SectionGap />
                    <GeneralSection />
                    <SectionGap />
                    <NewAgentDefaultsSection />
                    <SectionGap />
                    <RunRouteSection />
                    <SectionGap />
                    <TerminalSection />
                    <SectionGap />
                    <MemorySection />
                    <SectionGap />
                    <div id={SETTINGS_SECTION_EMBEDDINGS}>
                        <EmbeddingsSection />
                    </div>
                    <SectionGap />
                    <HeadlessAISection />
                </motion.div>
            </div>
        </MotionConfig>
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
                    "absolute top-[2px] h-[19px] w-[19px] rounded-full bg-white shadow-popover-line transition-all",
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
    const activeName = THEMES.find((t) => t.id === preset)?.name ?? "Midnight";
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
                <div data-theme-presets className="grid grid-cols-4 gap-2.5">
                    {THEMES.map((t) => {
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
                            className="cursor-pointer rounded border border-edge-mid px-[11px] py-1.5 text-[12px] font-semibold text-secondary hover:border-edge-strong hover:text-primary"
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
                                className="h-[22px] w-[22px] cursor-pointer rounded-sm border-2 p-0"
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
                            className="relative flex h-[22px] w-[22px] flex-none cursor-pointer items-center justify-center overflow-hidden rounded-sm border border-edge-mid"
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
                            "cursor-pointer rounded border px-3.5 py-[7px] text-[12.5px] font-semibold transition-colors",
                            runtime === r.id
                                ? "border-accent-700 bg-accentbg text-accent"
                                : "border-edge-mid bg-surface-raised text-secondary hover:border-edge-strong"
                        )}
                    >
                        {r.name}
                    </button>
                ))}
            </div>
            <motion.div
                key={runtime}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
                className="rounded-[14px] border border-border bg-surface px-4 py-1.5"
            >
                {catalog.length === 0 ? (
                    <div className="py-3 text-[12px] text-muted">No launch flags available</div>
                ) : (
                    catalog.map((f, i) => {
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
                    })
                )}
            </motion.div>
        </div>
    );
}

function RunRouteSection() {
    const preference = useAtomValue(harnessPreferenceAtom);
    return (
        <div>
            <SectionLabel>Run defaults</SectionLabel>
            <Row title="Run route" desc="Backend-authoritative harness, tier, and resolved model for new runs.">
                <RoutePicker value={preference.route} canInherit={false} onChange={(route) => route && setPreferredRoute(route)} />
            </Row>
            {preference.error ? <div className="mt-2 text-[12px] text-error">{preference.error}</div> : null}
        </div>
    );
}

function TerminalSection() {
    const fontSize = (useAtomValue(getSettingsKeyAtom("term:fontsize")) as number) ?? 12;
    const scrollback = (useAtomValue(getSettingsKeyAtom("term:scrollback")) as number) ?? 1000;
    const cursorRaw = (useAtomValue(getSettingsKeyAtom("term:cursor")) as string) ?? "block";
    const cursorBlink = (useAtomValue(getSettingsKeyAtom("term:cursorblink")) as boolean) ?? false;
    const copyOnSelect = (useAtomValue(getSettingsKeyAtom("term:copyonselect")) as boolean) ?? false;

    // SetConfigCommand's data param is a typed settings map; a dynamic-key patch needs the cast.
    const write = (patch: Record<string, unknown>) =>
        void RpcApi.SetConfigCommand(TabRpcClient, patch as Parameters<typeof RpcApi.SetConfigCommand>[1]);

    const cursor = cursorRaw === "bar" || cursorRaw === "underline" ? cursorRaw : "block";

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
            </div>
        </div>
    );
}

function MemorySection() {
    const stored = useAtomValue(getSettingsKeyAtom("memory:vaultpath"));
    const [draft, setDraft] = useState<string>(stored ?? "");
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const dirty = draft !== (stored ?? "");
    const showSaved = saved && !dirty;
    // validate before persisting: an empty path clears the override (falls back to the default vault),
    // otherwise the folder must exist and be a directory. reuses FileInfoCommand (bare local path, ~
    // expanded by the backend) instead of a dedicated RPC — mirrors the New Project picker's stat check.
    const commit = async () => {
        const path = draft.trim();
        setError(null);
        if (path !== "") {
            try {
                const info = await RpcApi.FileInfoCommand(TabRpcClient, { info: { path } });
                const err = vaultPathError(info);
                if (err) {
                    setError(err);
                    return;
                }
            } catch (e) {
                setError(String(e));
                return;
            }
        }
        await RpcApi.SetConfigCommand(TabRpcClient, { "memory:vaultpath": path });
        setSaved(true);
    };
    // native OS folder picker (Tauri dialog plugin), mirroring newprojectmodal's browse. dynamic import
    // keeps non-Tauri contexts (preview, vitest) clean. populates the draft; Save still commits.
    const browse = async () => {
        try {
            const { open } = await import("@tauri-apps/plugin-dialog");
            const picked = await open({ directory: true, multiple: false, title: "Select vault folder" });
            if (typeof picked === "string" && picked) {
                setDraft(picked);
                setSaved(false);
                setError(null);
            }
        } catch (e) {
            console.error("vault folder picker failed", e);
        }
    };
    return (
        <div>
            <SectionLabel>Memory</SectionLabel>
            <div className="text-[14px] font-semibold text-primary">Vault path</div>
            <div className="mb-3 mt-0.5 text-[12.5px] text-muted">Folder the Memory surface reads and writes.</div>
            <div className="flex gap-2.5">
                <div className="relative min-w-0 flex-1">
                    <input
                        type="text"
                        value={draft}
                        placeholder="~/vault"
                        onChange={(e) => {
                            setDraft(e.target.value);
                            setSaved(false);
                            setError(null);
                        }}
                        className="w-full rounded-[9px] border border-edge-mid bg-surface-raised py-2.5 pl-3.5 pr-10 font-mono text-[13px] text-primary outline-none focus:border-accent-700"
                    />
                    <button
                        type="button"
                        onClick={() => void browse()}
                        title="Browse for folder"
                        aria-label="Browse for folder"
                        className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-sm text-muted transition-colors hover:bg-surface-hover hover:text-primary"
                    >
                        <Folder size={15} />
                    </button>
                </div>
                <button
                    type="button"
                    onClick={() => void commit()}
                    className={cn(
                        "shrink-0 rounded-[9px] border px-[18px] text-[13px] font-semibold transition-colors",
                        showSaved
                            ? "border-success/40 bg-success/[0.14] text-success-soft animate-[settle_0.5s_ease-out] motion-reduce:animate-none"
                            : "border-edge-mid bg-surface-raised text-secondary hover:border-edge-strong"
                    )}
                >
                    {showSaved ? "Saved ✓" : "Save"}
                </button>
            </div>
            {error ? <div className="mt-2 text-[12px] text-error">{error}</div> : null}
        </div>
    );
}

// The secret the embedding provider reads (pkg/jarvisembed/embed.go). Never read back into the UI.
// Underscore, not colon: SetSecret validates against the shell env-var charset and rejects colons.
const EMBED_SECRET_NAME = "jarvis_embedapikey";

function SaveButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={cn(
                "shrink-0 rounded-[9px] border px-[18px] py-2.5 text-[13px] font-semibold transition-colors",
                disabled
                    ? "cursor-not-allowed opacity-40"
                    : label === "Saved ✓"
                      ? "border-success/40 bg-success/[0.14] text-success-soft animate-[settle_0.5s_ease-out] motion-reduce:animate-none"
                      : "border-edge-mid bg-surface-raised text-secondary hover:border-edge-strong"
            )}
        >
            {label}
        </button>
    );
}

function TextInput({
    value,
    placeholder,
    password,
    disabled,
    onChange,
}: {
    value: string;
    placeholder: string;
    password?: boolean;
    disabled?: boolean;
    onChange: (v: string) => void;
}) {
    return (
        <input
            type={password ? "password" : "text"}
            value={value}
            placeholder={placeholder}
            spellCheck={false}
            disabled={disabled}
            autoComplete={password ? "off" : undefined}
            onChange={(e) => onChange(e.target.value)}
            className={cn(
                "min-w-0 flex-1 rounded-[9px] border border-edge-mid bg-surface-raised px-3.5 py-2.5 font-mono text-[13px] text-primary outline-none focus:border-accent-700",
                disabled && "cursor-not-allowed opacity-40"
            )}
        />
    );
}

// One text-valued config key with its own draft/Save state, mirroring MemorySection's field (which keeps
// its own copy — it carries a folder picker and a stat check this has no use for).
function ConfigField({
    title,
    desc,
    placeholder,
    stored,
    onSave,
    disabled,
}: {
    title: string;
    desc: string;
    placeholder: string;
    stored: string;
    onSave: (value: string) => void;
    disabled?: boolean;
}) {
    const [draft, setDraft] = useState(stored);
    const [saved, setSaved] = useState(false);
    const showSaved = saved && draft === stored;
    return (
        <div className="border-t border-edge-faint py-3.5 first:border-t-0">
            <div className={cn("text-[14px] font-semibold", disabled ? "text-muted" : "text-primary")}>{title}</div>
            <div className="mb-2.5 mt-0.5 text-[12.5px] text-muted">{desc}</div>
            <div className="flex gap-2.5">
                <TextInput
                    value={draft}
                    placeholder={placeholder}
                    disabled={disabled}
                    onChange={(v) => {
                        setDraft(v);
                        setSaved(false);
                    }}
                />
                {disabled ? (
                    <span className="self-center font-mono text-[11px] tracking-[0.02em] text-ink-faint">
                        openrouter only
                    </span>
                ) : (
                    <SaveButton
                        label={showSaved ? "Saved ✓" : "Save"}
                        onClick={() => {
                            onSave(draft.trim());
                            setSaved(true);
                        }}
                    />
                )}
            </div>
        </div>
    );
}

// Embeddings (BYOK) — the opt-in semantic lane behind jarvisembed. Config goes through the ordinary
// settings-write path; the key goes to the OS secret store via SetSecrets, write-only in both directions
// (the UI can ask whether a key exists, never what it is).
function EmbeddingsSection() {
    const enabled = (useAtomValue(getSettingsKeyAtom("jarvis:embedenabled")) as boolean) ?? false;
    const baseURL = (useAtomValue(getSettingsKeyAtom("jarvis:embedbaseurl")) as string) ?? "";
    const model = (useAtomValue(getSettingsKeyAtom("jarvis:embedmodel")) as string) ?? "";

    const [keyDraft, setKeyDraft] = useState("");
    const [hasKey, setHasKey] = useState(false);
    const [keySaved, setKeySaved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fireAndForget(async () => {
            try {
                const names = await RpcApi.GetSecretsNamesCommand(TabRpcClient);
                setHasKey((names ?? []).includes(EMBED_SECRET_NAME));
            } catch (e) {
                setError(String(e));
            }
        });
    }, []);

    const write = (patch: Record<string, unknown>) =>
        void RpcApi.SetConfigCommand(TabRpcClient, patch as Parameters<typeof RpcApi.SetConfigCommand>[1]);

    const saveKey = () => {
        const key = keyDraft.trim();
        if (key === "") {
            return;
        }
        fireAndForget(async () => {
            setError(null);
            try {
                await RpcApi.SetSecretsCommand(TabRpcClient, { [EMBED_SECRET_NAME]: key });
                setKeyDraft(""); // write-only: the key is never held in the input after it lands
                setHasKey(true);
                setKeySaved(true);
            } catch (e) {
                setError(String(e));
            }
        });
    };

    // A null value deletes the secret (wshserver_secrets takes map[string]*string). The generated client
    // types values as string, so expressing "delete" needs the cast.
    const clearKey = () =>
        fireAndForget(async () => {
            setError(null);
            try {
                await RpcApi.SetSecretsCommand(TabRpcClient, { [EMBED_SECRET_NAME]: null } as unknown as Record<
                    string,
                    string
                >);
                setHasKey(false);
                setKeyDraft("");
                setKeySaved(false);
            } catch (e) {
                setError(String(e));
            }
        });

    // jarvisembed.Available() needs all four; short of that the lane stays dark however the toggle reads.
    const missing = [baseURL === "" && "a base URL", model === "" && "a model", !hasKey && "an API key"].filter(
        Boolean
    ) as string[];

    return (
        <div>
            <SectionLabel>Embeddings</SectionLabel>
            <div className="mb-4 rounded-[11px] border border-border bg-surface px-4 py-3 text-[12.5px] leading-[1.6] text-muted">
                Semantic recall calls an OpenAI-compatible{" "}
                <span className="font-mono text-[11.5px] text-secondary">/embeddings</span> endpoint that you supply and
                pay for — Wave never proxies it. For a local setup, point the base URL at a local server. Off by
                default: with it off, recall behaves exactly as it does today.
            </div>
            <div>
                <Row title="Enable semantic recall" desc="Index the vault and match on meaning, not just wording.">
                    <Toggle on={enabled} onToggle={() => write({ "jarvis:embedenabled": !enabled })} />
                </Row>
                <ConfigField
                    title="Base URL"
                    desc="Root of the OpenAI-compatible API, without the /embeddings suffix."
                    placeholder="https://api.openai.com/v1"
                    stored={baseURL}
                    onSave={(v) => write({ "jarvis:embedbaseurl": v })}
                />
                <ConfigField
                    title="Model"
                    desc="Embedding model id. Changing it re-indexes the vault on the next query."
                    placeholder="text-embedding-3-small"
                    stored={model}
                    onSave={(v) => write({ "jarvis:embedmodel": v })}
                />
                <div className="border-t border-edge-faint py-3.5">
                    <div className="text-[14px] font-semibold text-primary">API key</div>
                    <div className="mb-2.5 mt-0.5 text-[12.5px] text-muted">
                        Stored in the OS secret store, never in settings and never shown again.{" "}
                        <span className={cn("font-semibold", hasKey ? "text-success-soft" : "text-muted")}>
                            {hasKey ? "A key is stored." : "No key stored."}
                        </span>
                    </div>
                    <div className="flex gap-2.5">
                        <TextInput
                            value={keyDraft}
                            placeholder={hasKey ? "••••••••  (enter a new key to replace)" : "sk-…"}
                            password
                            onChange={(v) => {
                                setKeyDraft(v);
                                setKeySaved(false);
                            }}
                        />
                        <SaveButton label={keySaved ? "Saved ✓" : "Save"} onClick={saveKey} />
                        {hasKey ? (
                            <button
                                type="button"
                                onClick={clearKey}
                                className="shrink-0 rounded-[9px] border border-edge-mid bg-surface-raised px-[18px] py-2.5 text-[13px] font-semibold text-secondary transition-colors hover:border-error/50 hover:text-error"
                            >
                                Clear
                            </button>
                        ) : null}
                    </div>
                </div>
            </div>
            {enabled && missing.length > 0 ? (
                <div className="mt-3 text-[12px] text-warning">
                    Enabled, but still needs {missing.join(", ")} — semantic recall stays off until then.
                </div>
            ) : null}
            {error ? <div className="mt-2 text-[12px] text-error">{error}</div> : null}
        </div>
    );
}

function HeadlessAISection() {
    const runtime = (useAtomValue(getSettingsKeyAtom("headless:runtime")) as string) ?? "";
    const cheapModel = (useAtomValue(getSettingsKeyAtom("headless:openroutercheapmodel")) as string) ?? "";
    const midModel = (useAtomValue(getSettingsKeyAtom("headless:openroutermidmodel")) as string) ?? "";
    const longModel = (useAtomValue(getSettingsKeyAtom("headless:openrouterlongmodel")) as string) ?? "";

    const [hasKey, setHasKey] = useState(false);
    const [harnesses, setHarnesses] = useState<HarnessInfo[]>([]);
    const [open, setOpen] = useState(false);
    useEffect(() => {
        fireAndForget(async () => {
            try {
                const names = await RpcApi.GetSecretsNamesCommand(TabRpcClient);
                setHasKey((names ?? []).includes(EMBED_SECRET_NAME));
            } catch (_) {
                // best-effort probe; the key warning below simply stays "missing" on failure
            }
        });
        fireAndForget(async () => {
            try {
                const rtn = await RpcApi.ListHarnessesCommand(TabRpcClient);
                setHarnesses(rtn?.harnesses ?? []);
            } catch (_) {
                // best-effort probe; a failed catalog leaves the selector with openrouter only
            }
        });
    }, []);

    const write = (patch: Record<string, unknown>) =>
        void RpcApi.SetConfigCommand(TabRpcClient, patch as Parameters<typeof RpcApi.SetConfigCommand>[1]);

    // empty setting means openrouter (the backend default); only openrouter reads the model keys.
    const isOpenRouter = runtime === "" || runtime === "openrouter";
    const effectiveRuntime = isOpenRouter ? "openrouter" : runtime;

    const harnessRows = harnessPickerItems(harnesses, effectiveRuntime, "consult");
    const options = [
        {
            id: "openrouter",
            label: "OpenRouter",
            mono: "openrouter",
            selectable: true,
            isDefault: true,
            notInstalled: false,
        },
        ...harnessRows.map((h) => ({
            id: h.runtime,
            label: h.label,
            mono: h.runtime,
            selectable: h.selectable,
            isDefault: false,
            notInstalled: h.unavailableReason === "not-installed",
        })),
    ];
    const runtimeRow = options.find((o) => o.id === effectiveRuntime) ?? options[0];
    const summary = runtimeRow.isDefault
        ? hasKey
            ? "OpenRouter · key stored"
            : "OpenRouter · key missing"
        : `${runtimeRow.label} · ${runtimeRow.notInstalled ? "not installed" : "installed"}`;

    return (
        <div>
            <button
                type="button"
                onClick={() => setOpen(!open)}
                aria-expanded={open}
                className="flex w-full cursor-pointer items-center gap-1.5 text-left"
            >
                <ChevronRight
                    size={13}
                    className={cn("shrink-0 text-muted transition-transform duration-150", open && "rotate-90")}
                />
                <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted">
                    Headless AI
                </span>
                <span className="ml-auto truncate text-[11.5px] text-muted">{summary}</span>
            </button>
            {open ? (
                <>
                    <div className="mb-4 mt-3 rounded-[11px] border border-border bg-surface px-4 py-3 text-[12.5px] leading-[1.6] text-muted">
                        Runtime for background AI features (gatekeeper, decompose, continuity, proactive, recall,
                        volunteer, distill, gardener, radar, pi auto-titles). OpenRouter is the API-backed default and
                        uses the{" "}
                        <span className={cn("font-semibold", hasKey ? "text-success-soft" : "text-warning")}>
                            {hasKey ? "stored" : "missing"}
                        </span>{" "}
                        OpenRouter key from the secret store (same key as Embeddings); harness runtimes execute their
                        local CLI. Model IDs use the full{" "}
                        <code className="font-mono text-[11.5px] text-secondary">provider/model</code> format.
                    </div>
                    <div className="text-[14px] font-semibold text-primary">Runtime</div>
                    <div className="mb-2.5 mt-0.5 text-[12.5px] text-muted">
                        Which engine powers background AI features. Uninstalled harnesses stay visible but disabled —
                        install them to enable.
                    </div>
                    <div role="radiogroup" aria-label="headless runtime" className="flex flex-col gap-1.5">
                        {options.map((o) => {
                            const on = o.id === effectiveRuntime;
                            return (
                                <button
                                    key={o.id}
                                    type="button"
                                    role="radio"
                                    aria-checked={on}
                                    disabled={!o.selectable}
                                    onClick={() => write({ "headless:runtime": o.id })}
                                    className={cn(
                                        "flex w-full cursor-pointer items-center gap-2.5 rounded-[11px] border p-[10px] text-left transition-colors",
                                        on
                                            ? "border-accent-700 bg-surface-hover"
                                            : "border-border hover:border-edge-strong",
                                        !o.selectable && "cursor-not-allowed opacity-55 hover:border-border"
                                    )}
                                >
                                    <span
                                        className={cn(
                                            "flex h-4 w-4 flex-none items-center justify-center rounded-full border-2 transition-colors",
                                            on ? "border-accent" : "border-edge-strong"
                                        )}
                                    >
                                        {on ? <span className="h-2 w-2 rounded-full bg-accent" /> : null}
                                    </span>
                                    <span
                                        className={cn(
                                            "min-w-0 flex-1 truncate text-[13px] font-semibold",
                                            on ? "text-primary" : "text-secondary"
                                        )}
                                    >
                                        {o.label}
                                    </span>
                                    <span className="font-mono text-[10.5px] font-normal tracking-[0.02em] text-ink-faint">
                                        {o.mono}
                                    </span>
                                    <span
                                        className={cn(
                                            "flex flex-none items-center gap-1.5 text-[11px] font-semibold",
                                            o.isDefault
                                                ? hasKey
                                                    ? "text-accent-soft"
                                                    : "text-warning-soft"
                                                : o.notInstalled
                                                  ? "text-muted"
                                                  : "text-success-soft"
                                        )}
                                    >
                                        <span
                                            className={cn(
                                                "h-1.5 w-1.5 rounded-full",
                                                o.isDefault
                                                    ? hasKey
                                                        ? "bg-accent"
                                                        : "bg-warning"
                                                    : o.notInstalled
                                                      ? "bg-ink-faint"
                                                      : "bg-success"
                                            )}
                                        />
                                        {o.isDefault
                                            ? hasKey
                                                ? "default · key stored"
                                                : "default · key missing"
                                            : o.notInstalled
                                              ? "not installed"
                                              : "installed"}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                    <div className="mt-5">
                        <div className="flex items-baseline justify-between gap-3">
                            <div className="text-[14px] font-semibold text-primary">Models</div>
                            {!isOpenRouter ? (
                                <span className="flex-none rounded-[6px] border border-border bg-pill px-2 py-0.5 font-mono text-[10.5px] text-ink-faint">
                                    openrouter only
                                </span>
                            ) : null}
                        </div>
                        <div className="mb-2.5 mt-0.5 text-[12.5px] text-muted">
                            OpenRouter model IDs for mechanical, synthesis, and large-corpus tasks — only applies while
                            the runtime is openrouter.
                        </div>
                        <ConfigField
                            title="Cheap model"
                            desc="For mechanical tasks: gatekeeper, decompose, continuity, proactive."
                            placeholder="deepseek/deepseek-v4-flash"
                            stored={cheapModel}
                            disabled={!isOpenRouter}
                            onSave={(v) => write({ "headless:openroutercheapmodel": v })}
                        />
                        <ConfigField
                            title="Mid model"
                            desc="For synthesis and conversation: recall, radar, Jarvis."
                            placeholder="deepseek/deepseek-v4-pro"
                            stored={midModel}
                            disabled={!isOpenRouter}
                            onSave={(v) => write({ "headless:openroutermidmodel": v })}
                        />
                        <ConfigField
                            title="Long-context model"
                            desc="For large-corpus tasks: distillation, gardener when corpus > 400KB."
                            placeholder="deepseek/deepseek-v4-pro"
                            stored={longModel}
                            disabled={!isOpenRouter}
                            onSave={(v) => write({ "headless:openrouterlongmodel": v })}
                        />
                    </div>
                    {isOpenRouter && !hasKey ? (
                        <div className="mt-3 text-[12px] text-warning">
                            API key not set — background AI features are disabled until the key is configured.
                        </div>
                    ) : null}
                </>
            ) : null}
        </div>
    );
}
