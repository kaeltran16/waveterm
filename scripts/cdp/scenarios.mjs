// Verification scenario manifest. Each entry: { name, surface, arrange(h)->ctx, assert(h,ctx)->steps,
// teardown(h,ctx) }. arrange/assert/teardown run in Node and drive the browser via h (see attach.mjs).
// Asserts are RPC-based (backend state) or DOM-based (h.ev) — NOT jotai atom reads (globalStore is not
// exposed on window). steps are { step, ok, detail }.
// The scenarios live in scenarios-<area>.mjs by surface or feature; helpers more than one of them uses are in
// scenarios-shared.mjs. A new scenario goes in its area's module and into SCENARIOS below, whose order is the run
// order.
import { narrationFeed } from "./narrationfeed.mjs";
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
import findings from "./scenarios-brainstorm-findings.mjs";
import judge from "./scenarios-brainstorm-judge.mjs";
import review from "./scenarios-brainstorm-review.mjs";
import run from "./scenarios-brainstorm-run.mjs";
import spikes from "./scenarios-brainstorm-spikes.mjs";
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
import {
    diffComments,
    diffCompare,
    diffRename,
    diffReviewMarks,
    diffReviewMarksRun,
    diffSourceRow,
    gitHistory,
} from "./scenarios-files.mjs";
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
    codeSymbols,
    codeTreeOnArrival,
} from "./scenarios-code.mjs";
import {
    agentComposer,
    agentLaunchHero,
    agentRailFileLink,
    agentTerminalNames,
    agentTerminalOnArrival,
    agentTreeQuickReturn,
    agentTreeRail,
    canvasMark,
    canvasSwap,
    canvasTabsScenario,
    elementPrimitives,
    quickRunDone,
    remoteHand,
    resmonFooter,
    resmonLive,
    resmonMain,
    resmonStates,
    termLinkTooltip,
    termReturnReplay,
    terminalTheme,
    tuiFullscreen,
    tuiLeader,
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
    motionControls,
    remotePhone,
    remoteSwitchScenario,
    settingsClaudeAccount,
    settingsHeadless,
    settingsStorage,
    settingsVaultSync,
    setupMemory,
} from "./scenarios-settings.mjs";
import {
    briefComposerSteerOnly,
    briefContextualMap,
    briefDesignParity,
    briefInitiativesPolish,
    briefInlineTracker,
    briefPeek,
    briefPeeksPolish,
    briefAct,
    briefProfile,
    briefLiveInitiative,
    briefRestore,
    briefSurface,
    jarvisAvatar,
    jarvisAvatarActivity,
    jarvisAvatarFaults,
    jarvisMotion,
    jarvisPeek,
    jarvisVolunteer,
    peekCtrlClick,
    peekItemViews,
    recordBandDetachRestore,
    resourceLinking,
} from "./scenarios-brief.mjs";
import {
    autonomousRuns,
    dagLifecycle,
    dagMotionScenario,
    dagObservability,
    dagPeekScenario,
    dagReviewerSession,
    finalRerunScenario,
    finalShotsScenario,
    finalStageScenario,
    leadCardMergeGate,
    modelPicks,
    planReviewRounds,
    runCost,
    runSheetCardsLook,
    runSheetCarryScenario,
    runSheetDesigning,
    runSheetDoneLook,
    runSheetLegacyLook,
    runSheetPolish,
    runTimingScenario,
    taskDetail,
} from "./scenarios-runs.mjs";
import {
    newRunAttachments,
    newRunDefaults,
    newRunDesign,
    newRunWindow,
    paletteActions,
    paletteGoal,
    paletteNotes,
    paletteScopeIndicator,
    routePickerFlat,
    routePickerRefused,
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
    cockpitRailTooltip,
    contextMenu,
    docReview,
    docReviewApproval,
    docReviewNotes,
    messageModal,
    monitorTasksScenario,
    motionGaps,
    newProjectModal,
    notificationToasts,
    shellTasksScenario,
    surfaceHeaders,
    surfaceSmoke,
    titleTooltip,
    toolDetailModal,
    uiApi,
    uiDrift,
} from "./scenarios-cockpit.mjs";
import { codeSession } from "./scenarios-code-session.mjs";
import { codeJumps } from "./scenarios-code-jumps.mjs";
import { codeToolbar } from "./scenarios-code-toolbar.mjs";
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
import { SESSIONS_KIT } from "./scenarios-shared.mjs";


export const SCENARIOS = [
    cockpitKeysOnArrival,
    agentTerminalOnArrival,
    codeTreeOnArrival,
    briefContextualMap,
    briefRestore,
    briefComposerSteerOnly,
    terminalTheme,
    tuiLeader,
    tuiFullscreen,
    gitHistory,
    diffCompare,
    diffReviewMarks,
    diffReviewMarksRun,
    diffComments,
    diffSourceRow,
    diffRename,
    diffScope,
    diffStates,
    surfaceSmoke,
    surfaceHeaders,
    codeSearch,
    codeSymbols,
    codeSidebar,
    codeGitStatus,
    codePlainDir,
    codeDiff,
    codeBlame,
    codeReview,
    codeMarkdown,
    codeImageZoom,
    elementPrimitives,
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
    jarvisVolunteer,
    usageCharts,
    usageWork,
    usageStates,
    attentionCrossChannel,
    attentionPopup,
    cockpitNeedsYouCrossChannel,
    dagLifecycle,
    routePickerFlat,
    routePickerRefused,
    settingsHeadless,
    settingsVaultSync,
    settingsClaudeAccount,
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
    motionControls,
    narrationFeed,
    notesWsh,
    agentTreeRail,
    quickRunDone,
    agentTreeQuickReturn,
    docReview,
    docReviewApproval,
    docReviewNotes,
    cockpitPolish,
    leadCardMergeGate,
    runSheetPolish,
    runTimingScenario,
    runSheetCarryScenario,
    runCost,
    dagObservability,
    dagPeekScenario,
    dagMotionScenario,
    dagReviewerSession,
    recordBandDetachRestore,
    agentRailFileLink,
    shellTasksScenario,
    monitorTasksScenario,
    finalShotsScenario,
    finalRerunScenario,
    finalStageScenario,
    briefInitiativesPolish,
    briefPeeksPolish,
    newRunWindow,
    newRunAttachments,
    paletteActions,
    paletteScopeIndicator,
    autonomousRuns,
    paletteGoal,
    newRunDefaults,
    newRunDesign,
    runSheetDesigning,
    paletteNotes,
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
    ...findings(BS_KIT),
    ...judge(BS_KIT),
    ...review(BS_KIT),
    ...run(BS_KIT),
    ...spikes(BS_KIT),
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
    canvasMark,
    canvasTabsScenario,
    agentTerminalNames,
    resmonFooter,
    resmonMain,
    resmonStates,
    resmonLive,
    setupMemory,
    cockpitEmptyState,
    agentLaunchHero,
    newProjectModal,
    toolDetailModal,
    messageModal,
    notificationToasts,
    contextMenu,
    cockpitRailTooltip,
    termLinkTooltip,
    termReturnReplay,
    codePeek,
    titleTooltip,
    taskDetail,
    runSheetDoneLook,
    runSheetLegacyLook,
    runSheetCardsLook,
    codeStaleBarLook,
    codeSession,
    codeJumps,
    codeToolbar,
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
    // last: its fixture roster stands in for the live one until its teardown reloads
    agentComposer,
];
