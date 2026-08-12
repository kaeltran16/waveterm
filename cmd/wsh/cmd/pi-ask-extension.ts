// pi extension: the ask bridge (workstream F). Installed by `wsh install-agent-hooks` into
// ~/.pi/agent/extensions/waveterm-ask.ts with __WSH_PATH__ substituted for the absolute wsh
// path. Registers the canonical ask_user_question tool; questions surface in the Wave Agents
// panel (attention list) instead of pi's terminal questionnaire. Bare pi outside a Wave block
// fails closed with a plain-text fallback instruction.
import { Type } from "typebox";
import { buildAskEnvelope, buildAskPayload, parseAskResult } from "./waveterm-ask-core";

export function registerAskTool(pi: any, wshPath: string): void {
    pi.registerTool({
        name: "ask_user_question",
        label: "Ask User Question (Wave)",
        description: `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

The questions surface in the Wave Agents panel; the user answers there and the tool resumes with the answers.

Usage notes:
- Each question MUST have 2-4 options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs. The user can additionally type a custom answer via the automatically appended "Type something." row on every question, or dismiss the ask (which returns a decline). Do NOT author "Other" or "Type something." labels yourself.
- Use multiSelect: true when multiple answers are valid. Provide an options[].preview markdown string when an option benefits from richer side-by-side context (mockups, code snippets, diagrams, configs) — single-select only; the preview panel shows the focused option.
- Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.`,
        promptSnippet: "Ask the user up to 4 structured questions (2-4 options each) when requirements are ambiguous",
        promptGuidelines: [
            "Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions.",
            "Questions render in the Wave Agents panel, not the terminal questionnaire.",
            "preview is supported for single-select questions only; the panel shows the focused option's preview.",
        ],
        parameters: Type.Object({
            questions: Type.Array(
                Type.Object({
                    question: Type.String({ description: "The complete question to ask" }),
                    header: Type.Optional(
                        Type.String({ description: "Short tag shown next to the question (max 16 chars)" })
                    ),
                    multiSelect: Type.Optional(Type.Boolean({ description: "Allow multiple answers (default false)" })),
                    options: Type.Array(
                        Type.Object({
                            label: Type.String({ description: "Concise label (1-5 words, max 60 chars)" }),
                            description: Type.Optional(
                                Type.String({ description: "What this choice means or its trade-offs" })
                            ),
                            preview: Type.Optional(
                                Type.String({
                                    description: "Markdown content shown beside the option list (single-select only)",
                                })
                            ),
                        }),
                        { minItems: 2, maxItems: 4 }
                    ),
                }),
                { minItems: 1, maxItems: 4 }
            ),
        }),
        async execute(_toolCallId: string, params: any, signal: AbortSignal): Promise<unknown> {
            const payload = buildAskPayload(params.questions);
            try {
                const { stdout, killed } = await pi.exec(wshPath, ["ask", "--wait", "--questions-json", payload], {
                    signal,
                });
                if (killed) {
                    // user aborted the tool call (Esc) — same decline signal as dismissing
                    return buildAskEnvelope({ answers: [], cancelled: true }, params.questions);
                }
                return buildAskEnvelope(parseAskResult(stdout), params.questions);
            } catch (e) {
                // not in a Wave block, wsh missing, RPC failure — fail closed: the user never
                // saw the questions, so the model must re-ask them as plain chat text.
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error: Wave ask unavailable (${String(e)}). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead.`,
                        },
                    ],
                    details: { answers: [], cancelled: true },
                };
            }
        },
    });
}

export default function wavetermAsk(pi: any): void {
    registerAskTool(pi, "__WSH_PATH__");
}
