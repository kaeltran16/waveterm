// the terminal's answer surface for an AskUserQuestion the cockpit card is also showing: a focused
// pane where the arrows and Enter pick, as in claude's own dialog. "Other" is typed in its field.
// register.ts owns the state.
import type { Elements, RenderElement } from "claude-code";
import type { Picker } from "../types";

export type PickerActions = { pick: (n: number) => void; confirm: () => void; other: (text: string) => void };

type PickerElements = Pick<Elements["terminal"], "Box" | "Button" | "Input" | "Text">;

const HINTS = {
    single: "Arrows and Enter, or a number. Esc dismisses.",
    multi: "Enter or a number marks, then Done. Esc dismisses.",
};

// what the pane holds while it has no question to show
export function drawNoQuestion({ Text }: Pick<Elements["terminal"], "Text">): RenderElement {
    return <Text dimColor>No question.</Text>;
}

// null once every question is answered
export function drawAskPicker(
    { Box, Button, Input, Text }: PickerElements,
    p: Picker,
    act: PickerActions
): RenderElement | null {
    const q = p.questions[p.index];
    if (!q) {
        return null;
    }
    const hint = HINTS[q.multiSelect ? "multi" : "single"];

    return (
        <Box flexDirection="column">
            <Box gap={1}>
                <Text bold>{q.header}</Text>
                {p.questions.length > 1 && (
                    <Text dimColor>
                        {p.index + 1}/{p.questions.length}
                    </Text>
                )}
            </Box>
            <Text>{q.question}</Text>
            {q.options.map((o, n) => (
                <Box gap={1}>
                    <Button
                        key={`option-${p.index}-${n}`}
                        hotkey={String(n + 1)}
                        plain
                        autoFocus={n === 0 ? true : undefined}
                        label={q.multiSelect ? `${p.marked.includes(n) ? "[x]" : "[ ]"} ${o.label}` : o.label}
                        onPress={() => act.pick(n)}
                    />
                    {o.description && (
                        <Text dimColor wrap="truncate-end">
                            {o.description}
                        </Text>
                    )}
                </Box>
            ))}
            {q.multiSelect && (
                <Button
                    key={`done-${p.index}`}
                    hotkey={String(q.options.length + 1)}
                    plain
                    label="Done"
                    onPress={act.confirm}
                />
            )}
            <Input
                key={`other-${p.index}`}
                label="Other"
                placeholder="type your own answer"
                submitLabel="answer"
                onSubmit={act.other}
            />
            <Text dimColor>{hint} Also answerable in Arc's ask card.</Text>
        </Box>
    );
}
