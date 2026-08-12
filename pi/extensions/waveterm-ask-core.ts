// Pure helpers for the pi ask bridge extension. No external imports so the repo's vitest
// can cover it. The default export is a no-op: pi auto-loads every file in the extensions
// directory, and this module is a dependency, not an extension.

export interface AskOptionInput {
    label: string;
    description?: string;
    preview?: string;
}

export interface AskQuestionInput {
    question: string;
    header?: string;
    multiSelect?: boolean;
    options: AskOptionInput[];
}

export interface AskAnswerItem {
    selectedindexes?: number[];
    text?: string;
}

export interface AskResult {
    answers: AskAnswerItem[];
    cancelled: boolean;
}

export const DECLINE_MESSAGE = "User declined to answer questions";
export const ENVELOPE_PREFIX = "User has answered your questions:";
export const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";

// buildAskPayload serializes the questions for wsh ask --questions-json. Omit empty
// fields so the payload stays as small as argv allows; preview rides along for the
// cockpit's side-by-side render.
export function buildAskPayload(questions: AskQuestionInput[]): string {
    return JSON.stringify({
        questions: questions.map((q) => ({
            question: q.question,
            header: q.header || undefined,
            multiSelect: q.multiSelect || undefined,
            options: q.options.map((o) => ({
                label: o.label,
                description: o.description || undefined,
                preview: o.preview || undefined,
            })),
        })),
    });
}

// parseAskResult parses wsh ask --wait's stdout line. A null answers array (cancelled
// without answers) normalizes to [].
export function parseAskResult(stdout: string): AskResult {
    const j = JSON.parse(stdout);
    if (typeof j?.cancelled !== "boolean") {
        throw new Error("malformed ask result: missing cancelled");
    }
    const answers: AskAnswerItem[] = Array.isArray(j.answers) ? j.answers : [];
    return { answers, cancelled: j.cancelled };
}

// buildAskEnvelope maps the wsh result onto the rpiv-shaped tool envelope so the model
// sees the same canonical answered/declined signals whether the questionnaire ran in the
// pi TUI or in the Wave panel.
export function buildAskEnvelope(
    result: AskResult,
    questions: AskQuestionInput[]
): { content: { type: "text"; text: string }[]; details: { answers: unknown[]; cancelled: boolean } } {
    if (result.cancelled) {
        return {
            content: [{ type: "text", text: DECLINE_MESSAGE }],
            details: { answers: [], cancelled: true },
        };
    }
    const segments = questions.map((q, qi) => {
        const a = result.answers[qi] ?? { selectedindexes: [] };
        const answerText =
            a.text ?? (a.selectedindexes ?? []).map((i) => q.options[i]?.label ?? `option ${i + 1}`).join(", ");
        return `"${q.question}"="${answerText}".`;
    });
    const details = result.answers.map((a, qi) => ({
        questionIndex: qi,
        question: questions[qi]?.question ?? "",
        ...(a.text !== undefined ? { text: a.text } : { selectedIndexes: a.selectedindexes ?? [] }),
    }));
    return {
        content: [{ type: "text", text: `${ENVELOPE_PREFIX} ${segments.join(" ")} ${ENVELOPE_SUFFIX}` }],
        details: { answers: details, cancelled: false },
    };
}

export default function wavetermAskCore(): void {
    // no-op dependency module
}
