// pi extension reporting a running session into the Wave cockpit.
// Installed by `wsh install-agent-hooks` into ~/.pi/agent/extensions/waveterm-status.ts with
// __WSH_PATH__ substituted for the absolute wsh path. pi auto-loads every file in that directory.
// A bare pi outside a Wave block is fully inert: nothing runs without WAVETERM_BLOCKID + JWT.

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
            ctx.sessionManager.getSessionName?.() ?? "",
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
    pi.on("tool_execution_start", (event: any, ctx: any) => report(ctx, "working", event.toolName ?? "tool"));
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
