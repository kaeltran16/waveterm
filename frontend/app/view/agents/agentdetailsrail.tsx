// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { CollapsibleRail, RailPanelBody, type RailSection } from "@/app/element/collapsiblerail";
import { easeFluidCss, MOTION, popoverReveal } from "@/app/element/motiontokens";
import { SkeletonLine } from "@/app/element/skeleton";
import { globalStore } from "@/app/store/jotaiStore";
import { formatChordString } from "@/util/keysym";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { ArrowLeft, ArrowUpRight, ChevronLeft } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { driveAgent, NUDGE_INPUT } from "./agentactions";
import { agentDiffScope, openDiff } from "./agentdiffnav";
import {
    checkoutFacts,
    contextLevel,
    fileTotals,
    lastTurnInterrupted,
    railAction,
    toolChips,
    type FilesChip,
} from "./agentrailmodel";
import type { AgentsViewModel } from "./agents";
import { recentActions, summarizeActions, type AgentVM } from "./agentsviewmodel";
import { cardCwdByIdAtom, sharedCheckoutCount } from "./cardgitstore";
import { finalRowFocusId, isFinalStageId } from "./finalstage";
import { FinalStageRail } from "./finalstagerail";
import { capFiles, lineCountsShown, statusColor } from "./gitstatus";
import { leadLandFacts } from "./leadland";
import { entriesAtomFor, liveEntriesByIdAtom } from "./livetranscriptatoms";
import { prettyModel } from "./modellabel";
import { useRailGit } from "./railgit";
import { railVisibleAtom } from "./railstore";
import { useRoleAsks } from "./roleasks";
import { agentProject } from "./runlineage";
import { NeedsYouSection, RunSection, TaskSection } from "./runrailsections";
import { SectionLabel, SubLabel } from "./sectionlabel";
import type { SubagentState } from "./session-models/sessionviewmodel";
import {
    ContextLine,
    DetailLine,
    GAUGE_FILL,
    GAUGE_TEXT,
    SessionLine,
    useSessionLoaders,
    useSessionView,
} from "./sessionfacts";
import { focusSubagentAtom, subagentsByIdAtom } from "./subagentsstore";
import { TokenUsageSection } from "./tokenusagesection";

const SUB_COLOR: Record<SubagentState, string> = {
    working: "var(--color-accent)",
    success: "var(--color-success)",
    failure: "var(--color-error)",
    done: "var(--color-muted)",
};

const RailFilesCap = 8; // a 296px rail can't show a large worktree; the summary line under it counts them all

// RailStrip is the collapsed rail: the expand chevron, a badge for questions waiting on you, and the context
// window as a vertical gauge, so both read without opening the rail.
function RailStrip({ needs, ctxPct, ctxMax }: { needs: number; ctxPct?: number; ctxMax?: number }) {
    const level = ctxPct != null ? contextLevel(ctxPct, ctxMax) : "ok";
    const reduce = useReducedMotion();
    const tween = (props: string[]) =>
        reduce ? undefined : props.map((p) => `${p} ${MOTION.durMacro}s ${easeFluidCss}`).join(", ");
    return (
        <>
            <span className="relative block h-[18px] w-[18px]">
                <span className="flex h-[18px] w-[18px] items-center justify-center">
                    <ChevronLeft size={18} aria-hidden />
                </span>
                <AnimatePresence initial={false}>
                    {needs > 0 ? (
                        <motion.span
                            key="needs"
                            variants={popoverReveal}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            className="absolute -right-[8px] -top-[6px] flex h-[16px] min-w-[16px] items-center justify-center rounded-[8px] border-2 border-surface bg-warning px-[3px] font-mono text-[10.5px] font-bold leading-none text-on-warning"
                        >
                            {needs}
                        </motion.span>
                    ) : null}
                </AnimatePresence>
            </span>
            {ctxPct != null ? (
                <>
                    <span className="relative block h-[44px] w-[4px] overflow-hidden rounded-[2px] bg-border">
                        <span
                            className={cn("absolute inset-x-0 bottom-0", GAUGE_FILL[level])}
                            style={{
                                height: `${Math.min(100, Math.max(0, ctxPct))}%`,
                                transition: tween(["height", "background-color"]),
                            }}
                        />
                    </span>
                    <span
                        className={cn("font-mono text-[10.5px] font-semibold", GAUGE_TEXT[level])}
                        style={{ transition: tween(["color"]) }}
                    >
                        {Math.round(ctxPct)}%
                    </span>
                </>
            ) : null}
        </>
    );
}

function FileRow({
    status,
    path,
    adds,
    dels,
    counted = true,
    onClick,
}: {
    status: string;
    path: string;
    adds: number;
    dels: number;
    counted?: boolean;
    onClick?: () => void;
}) {
    const body = (
        <>
            <span className={cn("flex-none font-bold", statusColor(status))}>{status}</span>
            <span className="min-w-0 flex-1 truncate">{path}</span>
            {counted ? <span className="flex-none text-[10.5px] text-diff-added">+{adds}</span> : null}
            {counted && dels > 0 ? <span className="flex-none text-[10.5px] text-diff-removed">−{dels}</span> : null}
        </>
    );
    const cls =
        "flex items-center gap-[8px] rounded-sm px-[5px] py-[3px] text-left font-mono text-[11.5px] font-medium text-secondary";
    if (!onClick) {
        return <div className={cls}>{body}</div>;
    }
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(cls, "cursor-pointer hover:bg-surface-hover hover:text-primary")}
        >
            {body}
        </button>
    );
}

// FilesSummary keeps the deltas on one line in FileRow's colors, so a narrow rail wraps after the file count.
export function FilesSummary({ chip }: { chip: FilesChip }) {
    return (
        <>
            {chip.prefix ? `${chip.prefix} · ` : null}
            {chip.count}{" "}
            {chip.lines ? (
                <span className="whitespace-nowrap">
                    <span className="text-diff-added">+{chip.lines.adds}</span>{" "}
                    <span className="text-diff-removed">−{chip.lines.dels}</span>
                </span>
            ) : null}
        </>
    );
}

// SealedFiles lists what a done task's run recorded it changed. The worktree is gone, so there is no diff to open.
function SealedFiles({ files }: { files: EvidenceFile[] }) {
    if (files.length === 0) {
        return <div className="text-[11.5px] text-muted">No changes</div>;
    }
    const changes = files.map((f) => ({ path: f.path, status: f.stat, adds: f.add, dels: f.del }));
    const { shown } = capFiles(changes, RailFilesCap);
    const { count, adds, dels } = fileTotals(changes);
    return (
        <>
            <div className="flex flex-col gap-[7px]">
                {shown.map((f) => (
                    <FileRow key={f.path} status={f.status} path={f.path} adds={f.adds} dels={f.dels} />
                ))}
            </div>
            <div className="mt-[8px] font-mono text-[10.5px] text-muted">
                <FilesSummary chip={{ count, lines: { adds, dels } }} />
            </div>
        </>
    );
}

// The collapsed strip reads only the context % and the ask count. The panel and its loaders (the 1 s clock, usage
// and cache status every 15 s, the git read) mount only while the rail is open on the Agent surface, which stays
// mounted off-screen under every other surface.
export function AgentDetailsRail({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const open = useAtomValue(railVisibleAtom);
    const onAgent = useAtomValue(model.surfaceAtom) === "agent";
    const focusSub = useAtomValue(focusSubagentAtom);
    const inSub = focusSub?.parentId === agent.id;
    const { yours } = useRoleAsks(model, agent);
    const usage = agent.usage;
    const ctxPct = usage?.contextpct;
    const stripTitle = [
        "Agent details",
        ctxPct != null ? `context ${Math.round(ctxPct)}%` : "",
        yours.length > 0 ? `${yours.length} waiting on you` : "",
    ]
        .filter(Boolean)
        .join(" · ");
    return (
        <CollapsibleRail
            openAtom={railVisibleAtom}
            ariaLabel="Agent details"
            sections={[]}
            panel={open && onAgent ? <AgentDetailsPanel model={model} agent={agent} /> : null}
            strip={{
                content: (
                    <RailStrip needs={yours.length} ctxPct={inSub ? undefined : ctxPct} ctxMax={usage?.contextmax} />
                ),
                title: `${stripTitle} (${formatChordString("d")})`,
            }}
        />
    );
}

function AgentDetailsPanel({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const liveEntries = useAtomValue(entriesAtomFor(agent.id));
    const subs = useAtomValue(subagentsByIdAtom)[agent.id] ?? [];
    const focusSub = useAtomValue(focusSubagentAtom);
    const sub = focusSub?.parentId === agent.id ? focusSub : null;
    const subVM = sub ? subs.find((s) => s.id === sub.agentId) : undefined;
    const subEntries = useAtomValue(liveEntriesByIdAtom)[sub ? `sub:${sub.agentId}` : ""] ?? [];
    const ownEntries = liveEntries.length > 0 ? liveEntries : (agent.previousInfo ?? []);
    const entries = sub ? subEntries : ownEntries;
    const { lineage, role, roleRun, asks, yours } = useRoleAsks(model, agent);
    const agents = useAtomValue(model.agentsAtom);
    const tools = toolChips(summarizeActions(recentActions(entries, 0)).byVerb);
    const railState = useRailGit(agent);
    const session = useSessionView(model, agent);
    const { ended, standingBy, silentMs, live, age } = session;
    useSessionLoaders(
        agent,
        sub ? { id: `sub:${sub.agentId}`, path: sub.transcriptPath } : { id: agent.id, path: agent.transcriptPath }
    );

    const changes = railState?.changes?.files ?? [];
    const { shown: shownFiles } = capFiles(changes, RailFilesCap);
    const counted = lineCountsShown(railState?.changes);

    // A path is only worth linking when the rail resolved a working directory to resolve it against.
    const openFileDiff = (path?: string) => {
        globalStore.set(model.focusIdAtom, agent.id);
        openDiff(model, agentDiffScope(agent.id, agent.name, agent.agent), railState?.cwd && path ? path : undefined);
    };
    const drive = (data: string) => driveAgent(agent.blockId, data);

    // a land removes the run's worktree, so a landed lead's rail reads its run's landing, not its own checkout
    const landed = role?.kind === "lead" ? leadLandFacts(roleRun) : null;
    const sharedBy = sharedCheckoutCount(agent.id, useAtomValue(cardCwdByIdAtom));
    const { branch, worktree, worktreePath, chip } = checkoutFacts({ git: railState, landed, ended, sharedBy });
    const action = sub
        ? null
        : railAction({
              state: agent.state,
              age,
              live,
              standingBy,
              interrupted: lastTurnInterrupted(ownEntries),
              silentMs,
          });

    const subHead: RailSection[] =
        sub != null
            ? [
                  {
                      id: "subagent",
                      label: "Subagent",
                      content: (
                          <div className="flex flex-col gap-[6px]">
                              <SubLabel>Subagent of {agent.name}</SubLabel>
                              <div className="flex items-center gap-[8px]">
                                  <span
                                      className="h-[7px] w-[7px] shrink-0 rounded-full"
                                      style={{ background: SUB_COLOR[subVM?.state ?? "done"] }}
                                  />
                                  <span className="min-w-0 truncate font-mono text-[14px] font-semibold text-primary">
                                      {sub.label}
                                  </span>
                                  {subVM ? (
                                      <span
                                          className="ml-auto font-mono text-[10.5px] font-semibold"
                                          style={{ color: SUB_COLOR[subVM.state] }}
                                      >
                                          {subVM.state === "failure" ? "failed" : subVM.state}
                                      </span>
                                  ) : null}
                              </div>
                              <button
                                  type="button"
                                  onClick={() => globalStore.set(focusSubagentAtom, null)}
                                  className="-ml-[6px] inline-flex w-fit cursor-pointer items-center gap-[4px] rounded-[7px] px-[6px] py-[3px] font-mono text-[10.5px] font-semibold text-accent-soft hover:bg-surface-hover"
                              >
                                  <ArrowLeft size={11} aria-hidden />
                                  back to {agent.name}
                              </button>
                          </div>
                      ),
                  },
              ]
            : [];

    const details: RailSection = {
        id: "details",
        label: "Details",
        content: (
            <div>
                {/* only the lead's rail: a worker's own question is already on screen, in its terminal's picker */}
                {!sub && roleRun && role?.kind === "lead" ? (
                    <NeedsYouSection key={agent.id} model={model} run={roleRun} asks={yours} />
                ) : null}
                <div className="mb-[10px]">
                    <SectionLabel>Details</SectionLabel>
                </div>
                <div className="flex flex-col gap-[6px]">
                    {sub ? (
                        <>
                            <DetailLine label="Model">{subVM?.model ? prettyModel(subVM.model) : "—"}</DetailLine>
                            <DetailLine label="Session">
                                {subVM == null ? "—" : subVM.state === "failure" ? "failed" : subVM.state}
                            </DetailLine>
                        </>
                    ) : (
                        <>
                            <DetailLine label="Project">{agentProject(lineage, agents, agent) || "—"}</DetailLine>
                            <DetailLine label="Branch" title={branch || undefined}>
                                {branch || "—"}
                            </DetailLine>
                            {worktree ? (
                                <DetailLine label="Worktree" title={worktreePath} clipStart>
                                    {worktree}
                                </DetailLine>
                            ) : null}
                            <SessionLine view={session} />
                            {session.context ? <ContextLine ctx={session.context} blockId={agent.blockId} /> : null}
                        </>
                    )}
                </div>
            </div>
        ),
    };

    // the agent is its run's Final verification row: the stage's own id, or the current round's verifier session.
    // a tab an earlier round's verifier left is not the row, and keeps the rail it has
    const finalRun =
        !sub && role?.kind === "stage" && roleRun && finalRowFocusId(roleRun, [agent]) === agent.id
            ? roleRun
            : undefined;
    const finalSection: RailSection[] = finalRun
        ? [
              {
                  id: "final",
                  label: "Final verification",
                  content: <FinalStageRail key={finalRun.runId} model={model} run={finalRun} />,
              },
          ]
        : [];

    const sections: RailSection[] = [
        ...subHead,
        details,
        ...finalSection,
        ...(!sub && role && roleRun
            ? [
                  {
                      id: "run",
                      label: role.kind === "worker" ? "Task" : "Run",
                      content:
                          role.kind === "worker" ? (
                              <TaskSection
                                  key={agent.id}
                                  model={model}
                                  run={roleRun}
                                  taskId={role.taskId}
                                  asks={asks}
                              />
                          ) : (
                              <RunSection key={agent.id} model={model} run={roleRun} asks={asks} />
                          ),
                  },
              ]
            : []),
        {
            id: "usage",
            label: "Token usage",
            content: <TokenUsageSection />,
        },
        ...(!sub && subs.length > 0
            ? [
                  {
                      id: "subagents",
                      label: "Subagents",
                      content: (
                          <div>
                              <div className="mb-[11px] flex items-center justify-between">
                                  <SectionLabel>Subagents</SectionLabel>
                                  <span className="rounded-[20px] bg-accentbg px-[8px] py-[1px] font-mono text-[11px] font-semibold text-accent-soft">
                                      {subs.length}
                                  </span>
                              </div>
                              <div className="flex flex-col gap-[7px]">
                                  {subs.map((s) => {
                                      const path = s.transcriptPath;
                                      return (
                                          <div
                                              key={s.id}
                                              onClick={
                                                  path
                                                      ? () =>
                                                            globalStore.set(focusSubagentAtom, {
                                                                parentId: agent.id,
                                                                agentId: s.id,
                                                                transcriptPath: path,
                                                                label: s.type || "subagent",
                                                            })
                                                      : undefined
                                              }
                                              className={cn(
                                                  "flex items-center gap-[10px] rounded-[10px] border border-border bg-surface px-[11px] py-[9px]",
                                                  path && "cursor-pointer hover:border-edge-strong"
                                              )}
                                          >
                                              <span
                                                  className="h-[6px] w-[6px] shrink-0 rounded-full"
                                                  style={{ background: SUB_COLOR[s.state] }}
                                              />
                                              <div className="min-w-0 flex-1">
                                                  <div className="truncate font-mono text-[11.5px] font-semibold text-secondary">
                                                      {s.type || "subagent"}
                                                  </div>
                                                  <div className="truncate font-mono text-[10.5px] text-muted">
                                                      {s.model ?? ""}
                                                  </div>
                                              </div>
                                              <span
                                                  className="whitespace-nowrap font-mono text-[10.5px] font-semibold"
                                                  style={{ color: SUB_COLOR[s.state] }}
                                              >
                                                  {s.state === "failure" ? "failed" : s.state}
                                              </span>
                                          </div>
                                      );
                                  })}
                              </div>
                          </div>
                      ),
                  },
              ]
            : []),
        ...(tools.length > 0
            ? [
                  {
                      id: "tools",
                      label: "Tools used",
                      content: (
                          <div>
                              <div className="mb-[11px]">
                                  <SectionLabel>Tools used</SectionLabel>
                              </div>
                              <div className="flex flex-wrap gap-[7px]">
                                  {tools.map((t) => (
                                      <span
                                          key={t.verb}
                                          className="flex items-baseline gap-[5px] rounded-sm border border-edge-mid bg-surface-raised px-[9px] py-[4px] font-mono text-[11px] font-medium"
                                      >
                                          <span className={t.dim ? "text-muted" : "text-secondary"}>{t.verb}</span>
                                          <span className="text-[10.5px] text-muted">×{t.count}</span>
                                      </span>
                                  ))}
                              </div>
                          </div>
                      ),
                  },
              ]
            : []),
        ...(!sub
            ? [
                  {
                      id: "files",
                      label: "Files touched",
                      content: (
                          <div>
                              <div className="mb-[11px]">
                                  <SectionLabel>Files touched</SectionLabel>
                              </div>
                              {ended ? (
                                  <SealedFiles files={ended.files} />
                              ) : landed ? (
                                  <div data-rail-landed className="flex flex-col gap-[7px]">
                                      <div className="text-[11.5px] text-muted">{landed.files}</div>
                                      {landed.commits.map((c) => (
                                          <div
                                              key={c.sha}
                                              className="flex min-w-0 items-baseline gap-[8px] font-mono text-[11px]"
                                          >
                                              <span className="flex-none text-muted">{c.sha}</span>
                                              <span className="min-w-0 truncate text-secondary" title={c.subject}>
                                                  {c.subject}
                                              </span>
                                          </div>
                                      ))}
                                  </div>
                              ) : railState == null ? (
                                  <div aria-hidden="true" className="flex flex-col gap-2">
                                      {["w-[80%]", "w-[60%]", "w-[70%]"].map((w, i) => (
                                          <SkeletonLine key={i} className={cn("h-[10px]", w)} />
                                      ))}
                                  </div>
                              ) : !railState.isRepo ? (
                                  <div className="text-[11.5px] text-muted">Not a git repository</div>
                              ) : chip == null ? (
                                  <div className="text-[11.5px] text-muted">No changes</div>
                              ) : (
                                  <>
                                      <div className="flex flex-col gap-[7px]">
                                          {shownFiles.map((f) => (
                                              <FileRow
                                                  key={f.path}
                                                  status={f.status}
                                                  path={f.path}
                                                  adds={f.adds}
                                                  dels={f.dels}
                                                  counted={counted}
                                                  onClick={() => openFileDiff(f.path)}
                                              />
                                          ))}
                                      </div>
                                      <div className="mt-[8px] flex items-center justify-between gap-[10px] font-mono text-[10.5px]">
                                          {/* a checkout's changes are every agent's in it, so they read as the repo's */}
                                          <span
                                              data-rail-files-summary
                                              className="min-w-0 text-muted"
                                              title={chip.title}
                                          >
                                              <FilesSummary chip={chip} />
                                          </span>
                                          <button
                                              type="button"
                                              onClick={() => openFileDiff()}
                                              className="inline-flex flex-none cursor-pointer items-center gap-[3px] whitespace-nowrap rounded-[7px] px-[6px] py-[3px] font-semibold text-accent-soft hover:bg-surface-hover"
                                          >
                                              View diff
                                              <ArrowUpRight size={11} aria-hidden />
                                          </button>
                                      </div>
                                  </>
                              )}
                          </div>
                      ),
                  },
              ]
            : []),
    ];

    return (
        <RailPanelBody
            // the stage's own id is no session, so its rail is the stage alone
            sections={isFinalStageId(agent.id) ? finalSection : sections}
            footer={
                action ? (
                    <div className="flex items-center gap-[10px]">
                        <span
                            data-rail-hint
                            className={cn(
                                "min-w-0 flex-1 truncate font-mono text-[10.5px]",
                                action.tone === "warning" ? "text-warning" : "text-muted"
                            )}
                        >
                            {action.hint}
                        </span>
                        {action.kind === "none" ? null : action.kind === "resume" ? (
                            <button
                                type="button"
                                onClick={() => drive(NUDGE_INPUT)}
                                title="nudge the agent to continue from idle"
                                className="flex-none cursor-pointer rounded-[6px] border border-accent/45 bg-accent/10 px-[16px] py-[7px] text-[12px] font-medium text-accent-soft hover:bg-accent/[0.18]"
                            >
                                Resume
                            </button>
                        ) : (
                            <button
                                type="button"
                                onClick={() => drive("\x1b")}
                                title="interrupt the current turn"
                                className="flex-none cursor-pointer rounded-[6px] border border-error/30 bg-transparent px-[16px] py-[7px] text-[12px] font-medium text-error hover:bg-error/10"
                            >
                                Stop
                            </button>
                        )}
                    </div>
                ) : undefined
            }
        />
    );
}
