// pi extension: the Wave ask mirror (workstream F) + prose-question bridge (2026-08-13).
// Installed by `wsh install-agent-hooks` into ~/.pi/agent/extensions/waveterm-ask.ts with
// __WSH_PATH__ substituted for the absolute wsh path.
//
// Part 1 — ask mirror: does NOT register a tool and does NOT block. The
// @juicesharp/rpiv-ask-user-question package owns the single `ask_user_question` tool and
// its TUI questionnaire is the answer surface (registering a second `ask_user_question`
// would make pi hard-fail on the duplicate name). On `tool_call` we push the questions to
// the panel with a NON-waiting `wsh ask` (the card renders; no waiter is registered), and
// on `tool_result` we clear it with `wsh ask --clear`. Answering in the panel then takes
// the existing backend keystroke-injection path (pkg/agentask deliver.go): the panel click
// types down-arrows/enter into this block's terminal, driving the rpiv questionnaire to
// select the answer itself. Answering in the TUI completes the questionnaire directly and
// the clear hides the card.
//
// Part 2 — prose bridge: a turn that SETTLES with a bare-prose question (no tool call)
// projects the same card via `wsh ask --prose`; answers are typed as text into the
// terminal (no picker exists). The card clears on the next `agent_start` — answered,
// typed-in-terminal, or ignored, every outcome ends it.
//
// Outside a Wave block nothing runs at all.
import { buildAskPayload } from "./waveterm-ask-core";
import { detectProseQuestion } from "./waveterm-prose-core";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

// toolCallIds with a live panel mirror, so tool_result clears exactly the ask this call raised.
const mirroredToolCalls = new Set<string>();

// Prose-bridge turn state (one extension instance per pi process):
//   lastAssistantText — text blocks of the most recent finalized assistant message
//     (`message_end` fires for user/toolResult messages too; only assistant ones count).
//   turnUsedAskTool — the settled turn called ask_user_question: skip prose projection,
//     the tool already produced a card (a trailing "does that work?" flourish must not
//     double-card).
//   proseCardLive — a prose card is projected; the next agent_start clears it exactly once.
let lastAssistantText: string | null = null;
let turnUsedAskTool = false;
let proseCardLive = false;

// textBlocksOf joins the text content blocks of a finalized message. thinking/toolCall
// blocks never carry the question the human must read.
function textBlocksOf(message: any): string {
    if (!Array.isArray(message?.content)) {
        return "";
    }
    return message.content
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("\n");
}

function clearProseCard(pi: any, wshPath: string): void {
    if (!proseCardLive) {
        return;
    }
    proseCardLive = false;
    pi.exec(wshPath, ["ask", "--clear"]).catch(() => {});
}

function projectProseCard(pi: any, wshPath: string): void {
    if (turnUsedAskTool || !lastAssistantText) {
        return;
    }
    const q = detectProseQuestion(lastAssistantText);
    if (!q) {
        return;
    }
    const payload = buildAskPayload([{ question: q.question, options: q.options ?? [] }]);
    proseCardLive = true;
    // fire-and-forget so a slow wsh never blocks pi's settle; a failed projection just
    // leaves the question in the terminal (the pre-bridge behavior).
    pi.exec(wshPath, ["ask", "--prose", "--questions-json", payload]).catch(() => {
        proseCardLive = false;
    });
}

export function registerAskMirror(pi: any, wshPath: string): void {
    pi.on("tool_call", (event: any) => {
        if (event?.toolName !== ASK_USER_QUESTION_TOOL_NAME) {
            return undefined;
        }
        turnUsedAskTool = true;
        // Bare pi outside a Wave block: no panel to mirror to.
        if (!process.env.WAVETERM_BLOCKID) {
            return undefined;
        }
        const questions = event?.input?.questions;
        if (!Array.isArray(questions) || questions.length === 0) {
            return undefined;
        }
        mirroredToolCalls.add(event.toolCallId);
        const payload = buildAskPayload(questions);
        // fire-and-forget so the mirror can never delay the questionnaire; the card landing a
        // beat after the TUI prompt is fine (it is an attention surface, not the answer one).
        pi.exec(wshPath, ["ask", "--questions-json", payload]).catch(() => {
            mirroredToolCalls.delete(event.toolCallId);
        });
        return undefined; // rpiv's questionnaire runs and owns the tool result
    });
    pi.on("tool_result", (event: any) => {
        if (!mirroredToolCalls.has(event.toolCallId)) {
            return;
        }
        mirroredToolCalls.delete(event.toolCallId);
        pi.exec(wshPath, ["ask", "--clear"]).catch(() => {});
    });
    pi.on("message_end", (event: any) => {
        if (event?.message?.role === "assistant") {
            lastAssistantText = textBlocksOf(event.message);
        }
    });
    pi.on("agent_settled", () => {
        projectProseCard(pi, wshPath);
        lastAssistantText = null;
        turnUsedAskTool = false;
    });
    pi.on("agent_start", () => {
        clearProseCard(pi, wshPath);
        lastAssistantText = null;
        turnUsedAskTool = false;
    });
    pi.on("session_shutdown", () => {
        clearProseCard(pi, wshPath);
        lastAssistantText = null;
        turnUsedAskTool = false;
    });
}

export default function wavetermAsk(pi: any): void {
    registerAskMirror(pi, "__WSH_PATH__");
}
