// pi extension reporting a running session into the Wave cockpit.
// Installed by `wsh install-agent-hooks` into ~/.pi/agent/extensions/waveterm-status.ts with
// __WSH_PATH__ substituted for the absolute wsh path. pi auto-loads every file in that directory.
// A bare pi outside a Wave block is fully inert: nothing runs without WAVETERM_BLOCKID + JWT.

const TITLE_MAX = 72; // matches the Claude hook's head-text fallback cap (wshcmd-agenthook.go titleMax)

/** Text of a pi message entry: a bare string, or the joined text blocks. Mirrors pi's own
 *  extractTextContent (session-manager.js) so tool_result-only user turns yield "". */
function messageText(message: any): string {
    const content = message?.content;
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .filter((b: any) => b?.type === "text")
            .map((b: any) => b?.text ?? "")
            .join(" ");
    }
    return "";
}

/** First non-empty line of a message, rune-truncated — the Claude hook's titleFromPrompt shape. */
function headLine(text: string): string {
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) {
            return [...trimmed].slice(0, TITLE_MAX).join("");
        }
    }
    return "";
}

/** Session title for the cockpit row: the explicit name (pi's getSessionName), else the first user
 *  message's head text — the same "name or first message" display pi's own session selector uses.
 *  Mirrors the Claude hook's ai-title-then-prompt-fallback (wshcmd-agenthook.go). */
export function sessionTitle(sm: any): string {
    const name = sm?.getSessionName?.()?.trim();
    if (name) {
        return name;
    }
    for (const entry of sm?.getEntries?.() ?? []) {
        if (entry?.type !== "message") {
            continue;
        }
        const msg = entry.message;
        if (msg?.role !== "user") {
            continue;
        }
        const text = messageText(msg);
        if (text) {
            return headLine(text);
        }
    }
    return "";
}

export function registerWavetermStatus(pi: any, wshPath: string): void {
    let state: "working" | "idle" = "idle";
    const report = async (ctx: any, next: "working" | "idle", detail = "") => {
        state = next;
        const args = [
            "agentstatus",
            "--agent",
            "pi",
            "--state",
            next,
            "--cwd",
            ctx.cwd ?? "",
            "--transcript",
            ctx.sessionManager.getSessionFile() ?? "",
            "--session-id",
            ctx.sessionManager.getSessionId() ?? "",
            "--title",
            sessionTitle(ctx.sessionManager),
            "--provider",
            ctx.model?.provider ?? "",
            "--model",
            ctx.model?.id ?? "",
        ];
        if (detail) args.push("--detail", detail.slice(0, 160));
        try {
            await pi.exec(wshPath, args);
        } catch {
            /* live reporting is best-effort */
        }
    };

// detailForTool mirrors the Claude Code hook's activity line (wshcmd-agenthook.go): a compact
// "reading/editing/writing <basename>" from the tool call args, falling back to the bare tool name.
function basename(p: string): string {
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return i >= 0 ? p.slice(i + 1) : p;
}

function detailForTool(toolName: string, args: any): string {
    const name = String(toolName ?? "").toLowerCase();
    const path = typeof args?.path === "string" && args.path ? args.path : typeof args?.file_path === "string" ? args.file_path : "";
    switch (name) {
        case "read":
            return path ? "reading " + basename(path) : name;
        case "edit":
            return path ? "editing " + basename(path) : name;
        case "write":
            return path ? "writing " + basename(path) : name;
        case "bash":
            return typeof args?.command === "string" && args.command ? "running " + args.command.slice(0, 60) : name;
    }
    return name || "tool";
}

    const reportUsage = async (ctx: any) => {
        const usage = ctx.getContextUsage?.();
        if (usage?.percent == null) return;
        try {
            await pi.exec(wshPath, [
                "agentstatus",
                "--usage",
                "--context-pct",
                String(usage.percent),
                "--context-max",
                String(usage.contextWindow),
            ]);
        } catch {
            /* live reporting is best-effort */
        }
    };

    pi.on("session_start", (_event: any, ctx: any) => report(ctx, "idle"));
    pi.on("session_info_changed", (_event: any, ctx: any) => report(ctx, state));
    pi.on("model_select", (_event: any, ctx: any) => report(ctx, state));
    pi.on("agent_start", (_event: any, ctx: any) => report(ctx, "working"));
    pi.on("tool_execution_start", (event: any, ctx: any) => report(ctx, "working", detailForTool(event.toolName, event.args)));
    pi.on("message_end", async (_event: any, ctx: any) => {
        await report(ctx, state);
        await reportUsage(ctx);
    });
    pi.on("agent_settled", (_event: any, ctx: any) => report(ctx, "idle"));
    pi.on("session_shutdown", (_event: any, ctx: any) => report(ctx, "idle"));
}

export default function wavetermStatus(pi: any): void {
    registerWavetermStatus(pi, "__WSH_PATH__");
}
