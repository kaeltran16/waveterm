// Pure preview-layout logic for the answer surface, mirroring rpiv's rule: previews are
// single-select only, and the panel shows the focused option's preview.
import type { AgentAskQuestion } from "./agentsviewmodel";

export function previewMode(question: AgentAskQuestion): boolean {
    if (question.multiSelect) {
        return false;
    }
    return (question.options ?? []).some((o) => !!o.preview);
}

export function activePreview(question: AgentAskQuestion, focusIndex: number): string | undefined {
    const opts = question.options ?? [];
    if (opts.length === 0) {
        return undefined;
    }
    // out-of-range focus (defensive; the component only sets valid option indices)
    // defaults to the first option so the panel stays populated.
    if (focusIndex < 0 || focusIndex >= opts.length) {
        return opts[0]?.preview || undefined;
    }
    return opts[focusIndex]?.preview || undefined;
}

const FENCE = /^```[^`]*$/;

// the text the preview panel shows as written, in monospace, as claude's dialog does: previews are ASCII
// mockups and snippets, which markdown would reflow (joined lines, dropped indents, a dashed line read as a
// heading). a code fence wrapping the whole preview is unwrapped to its contents
export function previewBody(preview: string): string {
    const lines = preview.replace(/\n+$/, "").split("\n");
    const fences = lines.filter((l) => FENCE.test(l.trim())).length;
    const isWrapped =
        lines.length >= 2 && fences === 2 && FENCE.test(lines[0].trim()) && lines[lines.length - 1].trim() === "```";
    return isWrapped ? lines.slice(1, -1).join("\n") : lines.join("\n");
}
