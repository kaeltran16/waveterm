// pi extension: the Wave ask mirror (workstream F). Installed by `wsh install-agent-hooks` into
// ~/.pi/agent/extensions/waveterm-ask.ts with __WSH_PATH__ substituted for the absolute wsh
// path.
//
// This extension does NOT register a tool and does NOT block. The
// @juicesharp/rpiv-ask-user-question package owns the single `ask_user_question` tool and its
// TUI questionnaire is the answer surface (registering a second `ask_user_question` would make
// pi hard-fail on the duplicate name).
//
// The Wave panel card mirrors the same question set CC-style: on `tool_call` we push the
// questions to the panel with a NON-waiting `wsh ask` (the card renders; no waiter is
// registered), and on `tool_result` we clear it with `wsh ask --clear` (CC parity: its
// PostToolUse hook runs the same clear). Answering in the panel then takes the existing backend
// keystroke-injection path (pkg/agentask deliver.go, no waiter -> EncodeAnswer + sendInput):
// the panel click types down-arrows/enter into this block's terminal, driving the rpiv
// questionnaire to select the answer itself. Answering in the TUI completes the questionnaire
// directly and the clear hides the card. Outside a Wave block nothing runs at all.
import { buildAskPayload } from "./waveterm-ask-core";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

// toolCallIds with a live panel mirror, so tool_result clears exactly the ask this call raised.
const mirroredToolCalls = new Set<string>();

export function registerAskMirror(pi: any, wshPath: string): void {
    pi.on("tool_call", (event: any) => {
        if (event?.toolName !== ASK_USER_QUESTION_TOOL_NAME) return undefined;
        // Bare pi outside a Wave block: no panel to mirror to.
        if (!process.env.WAVETERM_BLOCKID) return undefined;
        const questions = event?.input?.questions;
        if (!Array.isArray(questions) || questions.length === 0) return undefined;
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
        if (!mirroredToolCalls.has(event.toolCallId)) return;
        mirroredToolCalls.delete(event.toolCallId);
        pi.exec(wshPath, ["ask", "--clear"]).catch(() => {});
    });
}

export default function wavetermAsk(pi: any): void {
    registerAskMirror(pi, "__WSH_PATH__");
}
