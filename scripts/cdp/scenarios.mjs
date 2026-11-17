// Verification scenario manifest. Each entry: { name, surface, arrange(h)->ctx, assert(h,ctx)->steps,
// teardown(h,ctx) }. arrange/assert/teardown run in Node and drive the browser via h (see attach.mjs).
// Asserts are RPC-based (backend state) or DOM-based (h.ev) — NOT jotai atom reads (globalStore is not
// exposed on window). steps are { step, ok, detail }.
// The scenarios live in scenarios-<area>.mjs by surface or feature; helpers more than one of them uses are in
// scenarios-shared.mjs. A new scenario goes in its area's module and into SCENARIOS below, whose order is the run
// order.
import { narrationFeed } from "./narrationfeed.mjs";
import { transcriptBase } from "./scenarios-transcript-base.mjs";
import { transcriptInitiative } from "./scenarios-transcript-initiative.mjs";
import { transcriptDag } from "./scenarios-transcript-dag.mjs";
import { transcriptDagActions } from "./scenarios-transcript-dagactions.mjs";
import { transcriptRuns } from "./scenarios-transcript-runs.mjs";
import { transcriptAgents } from "./scenarios-transcript-agents.mjs";
import { transcriptNotes } from "./scenarios-transcript-notes.mjs";
import { transcriptArc } from "./scenarios-transcript-arc.mjs";
import { transcriptBoards } from "./scenarios-transcript-boards.mjs";
import { transcriptLive } from "./scenarios-transcript-live.mjs";
import { transcriptMedia } from "./scenarios-transcript-media.mjs";
import { renderedShell } from "./scenarios-rendered-shell.mjs";
import { codeImageZoom } from "./scenarios-code-imagezoom.mjs";
import { codePeek } from "./scenarios-codepeek.mjs";
import { jiraSettings } from "./scenarios-jira-settings.mjs";
import { jiraCheck } from "./scenarios-jira-check.mjs";
import { jiraInitiative } from "./scenarios-jira-initiative.mjs";
import { jiraPost } from "./scenarios-jira-post.mjs";
import { jiraSidebar } from "./scenarios-jira-sidebar.mjs";
import { jiraDetails } from "./scenarios-jira-details.mjs";
import { jiraWsh } from "./scenarios-jira-wsh.mjs";
import { notesWsh } from "./notes-wsh.mjs";
import builder from "./scenarios-brainstorm-builder.mjs";
import judge from "./scenarios-brainstorm-judge.mjs";
import review from "./scenarios-brainstorm-review.mjs";
import run from "./scenarios-brainstorm-run.mjs";
import working from "./scenarios-brainstorm-working.mjs";
import sessionsList from "./scenarios-sessions.mjs";
import sessionsFind from "./scenarios-sessions-find.mjs";
import sessionsPalette from "./scenarios-sessions-palette.mjs";
import sessionsListStates from "./scenarios-sessions-list-states.mjs";
import sessionsDetailStates from "./scenarios-sessions-detail-states.mjs";
import sessionsPaletteResume from "./scenarios-sessions-palette-resume.mjs";
import agentStartFailed from "./scenarios-agent-start-failed.mjs";
import agentStreams from "./scenarios-agent-streams.mjs";
import agentSubagents from "./scenarios-agent-subagents.mjs";
import agentKeys from "./scenarios-agent-keys.mjs";
import agentHeader from "./scenarios-agent-header.mjs";
import agentRail from "./scenarios-agent-rail.mjs";
import agentTree from "./scenarios-agent-tree.mjs";
import agentRendered from "./scenarios-agent-rendered.mjs";
import agentQueued from "./scenarios-agent-queued.mjs";
import { workspacePane } from "./scenarios-workspace-pane.mjs";
import { workspaceHeader } from "./scenarios-workspace-header.mjs";
import { workspaceRing } from "./scenarios-workspace-ring.mjs";
import { workspaceRun } from "./scenarios-workspace-run.mjs";
import { workspaceChanges } from "./scenarios-workspace-changes.mjs";
import { workspaceFile } from "./scenarios-workspace-file.mjs";
import { workspaceBrainstormCanvas } from "./scenarios-workspace-brainstorm-canvas.mjs";
import { RENDERED_BS_SCENARIOS } from "./scenarios-rendered-brainstorm.mjs";
import {
    diffComments,
    diffCompare,
    diffReviewMarks,
    diffSourceRow,
    gitHistory,
} from "./scenarios-files.mjs";
import { diffPush } from "./scenarios-files-push.mjs";
import { diffScope } from "./scenarios-files-scope.mjs";
import { diffStates } from "./scenarios-files-states.mjs";
import {
    codeBlame,
    codeDiff,
    codeGitStatus,
    codeMarkdown,
    codePlainDir,
    codeReview,
    codeSearch,
    codeSidebar,
    codeStaleBarLook,
    codeTreeOnArrival,
} from "./scenarios-code.mjs";
import {
    agentComposer,
    agentLaunchHero,
    agentTreeRail,
    canvasMark,
    canvasSwap,
    canvasTabsScenario,
    remoteHand,
    resmonFooter,
    resmonMain,
    resmonStates,
    termLinkTooltip,
} from "./scenarios-agent.mjs";
import {
    attentionCrossChannel,
    attentionPopup,
    cockpitNeedsYouCrossChannel,
    usageCharts,
    usageStates,
    usageWork,
    workflowScan,
    workflowScanEntry,
} from "./scenarios-usage.mjs";
import {
    remotePhone,
    remoteSwitchScenario,
    settingsClaudeAccount,
    settingsClaudeApiKey,
    settingsClaudeApiKeySwitch,
    settingsHeadless,
    settingsPlanSkill,
    settingsStorage,
    setupMemory,
} from "./scenarios-settings.mjs";
import { setupInstructions } from "./scenarios-setup-instructions.mjs";
import { setupSkills } from "./scenarios-setup-skills.mjs";
import {
    briefComposerSteerOnly,
    briefDesignParity,
    briefProfile,
    briefLiveInitiative,
    briefSurface,
    resourceLinking,
} from "./scenarios-brief.mjs";
import { briefInitiativesPolish, briefPeeksPolish } from "./scenarios-brief-polish.mjs";
import {
    jarvisAvatar,
    jarvisAvatarActivity,
    jarvisAvatarFaults,
    jarvisMotion,
    jarvisPeek,
} from "./scenarios-jarvis.mjs";
import { briefInlineTracker, briefAct } from "./scenarios-brief-act.mjs";
import {
    briefContextualMap,
    briefPeek,
    peekCtrlClick,
    peekItemViews,
    recordBandDetachRestore,
} from "./scenarios-brief-peek.mjs";
import {
    autonomousRuns,
    leadCardMergeGate,
    runCost,
    runSheetDesigning,
    runSheetPolish,
    runTimingScenario,
} from "./scenarios-runs.mjs";
import { modelPicks, planReviewRounds } from "./scenarios-plan-review.mjs";
import { finalRerunScenario, finalShotsScenario, finalStageScenario } from "./scenarios-final.mjs";
import { dagLifecycle, dagMotionScenario, dagObservability, dagPeekScenario } from "./scenarios-dag.mjs";
import {
    newRunDesign,
    newRunWindow,
    paletteActions,
    paletteGoal,
    paletteNotes,
    paletteReviewFixes,
    paletteScopeIndicator,
    routePickerFlat,
} from "./scenarios-palette.mjs";
import {
    BS_KIT,
    brainstormAnswerBoards,
    brainstormMainBoard,
    brainstormMode,
    brainstormQuestionReasons,
    brainstormRailReasons,
    brainstormReviewSkim,
} from "./scenarios-brainstorm.mjs";
import {
    cockpitEmptyState,
    cockpitKeysOnArrival,
    cockpitPolish,
    contextMenu,
    motionGaps,
    notificationToasts,
    surfaceHeaders,
    surfaceSmoke,
    uiApi,
    uiDrift,
} from "./scenarios-cockpit.mjs";
import { monitorTasksScenario, shellTasksScenario } from "./scenarios-shell-tasks.mjs";
import { docReview, docReviewNotes } from "./scenarios-doc-review.mjs";
import { codeSession } from "./scenarios-code-session.mjs";
import { codeJumps } from "./scenarios-code-jumps.mjs";
import { codeToolbar } from "./scenarios-code-toolbar.mjs";
import { projectOverview } from "./scenarios-project-overview.mjs";
import { codeKeys } from "./scenarios-code-keys.mjs";
import { codeHandoff } from "./scenarios-code-handoff.mjs";
import { codeChanged } from "./scenarios-code-changed.mjs";
import { codeBlameDraft } from "./scenarios-code-blame-draft.mjs";
import { codeDiffStates } from "./scenarios-code-diff-states.mjs";
import { codeEditor } from "./scenarios-code-editor.mjs";
import { cockpitAskKeys } from "./scenarios-cockpit-asks.mjs";
import { cockpitCardLayout } from "./scenarios-cockpit-card.mjs";
import { cockpitComposerSend } from "./scenarios-cockpit-composer.mjs";
import { cockpitLaunchStays } from "./scenarios-cockpit-launch.mjs";
import { cockpitOffgrid } from "./scenarios-cockpit-offgrid.mjs";
import { cockpitRailHelp } from "./scenarios-cockpit-rail.mjs";
import { cockpitRosterCounts } from "./scenarios-cockpit-roster.mjs";
import { motionRunSheet } from "./scenarios-motion-run-sheet.mjs";
import { motionDagPeek } from "./scenarios-motion-dag-peek.mjs";
import { dagRunSettings } from "./scenarios-dag-run-settings.mjs";
import { motionPeeks } from "./scenarios-motion-peeks.mjs";
import { motionFinal } from "./scenarios-motion-final.mjs";
import { motionBrief } from "./scenarios-motion-brief.mjs";
import { motionBriefControls } from "./scenarios-motion-brief-controls.mjs";
import { motionBrainstorm } from "./scenarios-motion-brainstorm.mjs";
import { motionLens } from "./scenarios-motion-lens.mjs";
import { motionAgent } from "./scenarios-motion-agent.mjs";
import { motionDiff } from "./scenarios-motion-diff.mjs";
import { motionCode } from "./scenarios-motion-code.mjs";
import { SESSIONS_KIT } from "./scenarios-shared.mjs";
import { BOARDS_ASK_SCENARIOS } from "./scenarios-boards-ask.mjs";


export const SCENARIOS = [
    cockpitKeysOnArrival,
    codeTreeOnArrival,
    briefContextualMap,
    briefComposerSteerOnly,
    gitHistory,
    diffCompare,
    diffReviewMarks,
    diffComments,
    diffSourceRow,
    diffScope,
    diffStates,
    diffPush,
    surfaceSmoke,
    surfaceHeaders,
    codeSearch,
    codeSidebar,
    codeGitStatus,
    codePlainDir,
    codeDiff,
    codeBlame,
    codeReview,
    codeMarkdown,
    codeImageZoom,
    jarvisAvatar,
    jarvisAvatarFaults,
    jarvisAvatarActivity,
    briefSurface,
    briefAct,
    briefLiveInitiative,
    briefPeek,
    peekCtrlClick,
    peekItemViews,
    briefProfile,
    jarvisPeek,
    usageCharts,
    usageWork,
    usageStates,
    attentionCrossChannel,
    attentionPopup,
    cockpitNeedsYouCrossChannel,
    dagLifecycle,
    dagRunSettings,
    routePickerFlat,
    settingsHeadless,
    settingsPlanSkill,
    settingsClaudeAccount,
    settingsClaudeApiKey,
    settingsClaudeApiKeySwitch,
    settingsStorage,
    remoteSwitchScenario,
    remotePhone,
    remoteHand,
    jarvisMotion,
    // before brief-inline-tracker, which leaves a briefing fixture on over the seeded data
    briefDesignParity,
    briefInlineTracker,
    resourceLinking,
    uiApi,
    motionGaps,
    motionRunSheet,
    motionDagPeek,
    motionPeeks,
    motionFinal,
    motionBrief,
    motionBriefControls,
    motionBrainstorm,
    motionLens,
    motionAgent,
    motionDiff,
    motionCode,
    narrationFeed,
    transcriptBase,
    transcriptInitiative,
    transcriptDag,
    transcriptDagActions,
    transcriptRuns,
    transcriptAgents,
    transcriptNotes,
    transcriptArc,
    transcriptBoards,
    transcriptLive,
    transcriptMedia,
    renderedShell,
    notesWsh,
    agentTreeRail,
    docReview,
    docReviewNotes,
    cockpitPolish,
    leadCardMergeGate,
    runSheetPolish,
    runTimingScenario,
    runCost,
    dagObservability,
    dagPeekScenario,
    dagMotionScenario,
    recordBandDetachRestore,
    shellTasksScenario,
    monitorTasksScenario,
    finalShotsScenario,
    finalRerunScenario,
    finalStageScenario,
    briefInitiativesPolish,
    briefPeeksPolish,
    newRunWindow,
    paletteActions,
    paletteScopeIndicator,
    autonomousRuns,
    paletteGoal,
    newRunDesign,
    runSheetDesigning,
    paletteNotes,
    paletteReviewFixes,
    modelPicks,
    planReviewRounds,
    canvasSwap,
    brainstormMode,
    brainstormAnswerBoards,
    brainstormMainBoard,
    brainstormQuestionReasons,
    brainstormReviewSkim,
    brainstormRailReasons,
    ...builder(BS_KIT),
    ...judge(BS_KIT),
    ...review(BS_KIT),
    ...run(BS_KIT),
    ...working(BS_KIT),
    ...sessionsList(SESSIONS_KIT),
    ...sessionsFind(SESSIONS_KIT),
    ...sessionsPalette(SESSIONS_KIT),
    ...sessionsListStates(SESSIONS_KIT),
    ...sessionsDetailStates(SESSIONS_KIT),
    ...sessionsPaletteResume(SESSIONS_KIT),
    ...agentStartFailed(SESSIONS_KIT),
    ...agentStreams(SESSIONS_KIT),
    ...agentSubagents(SESSIONS_KIT),
    ...agentKeys(SESSIONS_KIT),
    ...agentHeader(SESSIONS_KIT),
    ...agentRail(SESSIONS_KIT),
    ...agentTree(SESSIONS_KIT),
    ...agentRendered(SESSIONS_KIT),
    ...agentQueued(SESSIONS_KIT),
    workspacePane,
    workspaceHeader,
    workspaceRing,
    workspaceRun,
    workspaceChanges,
    workspaceFile,
    workspaceBrainstormCanvas,
    ...RENDERED_BS_SCENARIOS,
    canvasMark,
    canvasTabsScenario,
    resmonFooter,
    resmonMain,
    resmonStates,
    setupMemory,
    setupInstructions,
    setupSkills,
    cockpitEmptyState,
    agentLaunchHero,
    notificationToasts,
    contextMenu,
    termLinkTooltip,
    codePeek,
    codeStaleBarLook,
    codeSession,
    codeJumps,
    codeToolbar,
    projectOverview,
    codeKeys,
    codeHandoff,
    codeChanged,
    codeBlameDraft,
    codeDiffStates,
    codeEditor,
    uiDrift,
    cockpitComposerSend,
    cockpitAskKeys,
    cockpitLaunchStays,
    cockpitRosterCounts,
    cockpitOffgrid,
    cockpitCardLayout,
    cockpitRailHelp,
    workflowScan,
    workflowScanEntry,
    jiraSettings,
    jiraCheck,
    jiraInitiative,
    jiraPost,
    jiraSidebar,
    jiraDetails,
    jiraWsh,
    ...BOARDS_ASK_SCENARIOS,
    // last: its fixture roster stands in for the live one until its teardown reloads
    agentComposer,
];
