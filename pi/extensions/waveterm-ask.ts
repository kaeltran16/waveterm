// pi extension: the ask bridge (workstream F). Installed by `wsh install-agent-hooks` into
// ~/.pi/agent/extensions/waveterm-ask.ts with __WSH_PATH__ substituted for the absolute wsh
// path.
//
// This extension does NOT register a tool. The @juicesharp/rpiv-ask-user-question package owns
// the single `ask_user_question` tool (its terminal questionnaire is the bare-pi fallback, the
// way Claude Code's built-in AskUserQuestion prompt is the fallback there). Registering a second
// `ask_user_question` would make pi hard-fail on the duplicate name.
//
// Instead it intercepts the `tool_call` event — pi's analog of Claude Code's PreToolUse hook.
// When running inside a Wave block (WAVETERM_BLOCKID set), it runs `wsh ask --wait` and returns
// `{ block: true, reason: <answer envelope> }`: the call becomes an error tool result whose text
// is the reason, the rpiv tool's own execute never runs, and the terminal questionnaire never
// renders. Outside a Wave block it returns `undefined`, so the rpiv terminal questionnaire runs
// untouched.
import { buildAskEnvelope, buildAskPayload, parseAskResult } from "./waveterm-ask-core";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

export function registerAskIntercept(pi: any, wshPath: string): void {
    pi.on("tool_call", async (event: any, ctx: any) => {
        if (event?.toolName !== ASK_USER_QUESTION_TOOL_NAME) return undefined;
        // Bare pi outside a Wave block: let the rpiv terminal questionnaire run.
        if (!process.env.WAVETERM_BLOCKID) return undefined;
        const questions = event?.input?.questions;
        if (!Array.isArray(questions) || questions.length === 0) return undefined;
        const payload = buildAskPayload(questions);
        try {
            const { stdout, killed } = await pi.exec(wshPath, ["ask", "--wait", "--questions-json", payload], {
                signal: ctx?.signal,
            });
            const result = killed ? { answers: [], cancelled: true } : parseAskResult(stdout);
            const envelope = buildAskEnvelope(result, questions);
            // block + reason = the model receives the answers as the tool result (CC deny+reason
            // parity). The "Error:" prefix the terminal adds is parsed as an answer, same as CC.
            return { block: true, reason: envelope.content[0].text };
        } catch (e) {
            // In a Wave block but wsh/RPC failed — fail closed: the user never saw the
            // questions, so the model must re-ask them as plain chat text.
            return {
                block: true,
                reason: `Error: Wave ask unavailable (${String(e)}). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead.`,
            };
        }
    });
}

export default function wavetermAsk(pi: any): void {
    registerAskIntercept(pi, "__WSH_PATH__");
}
