import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { closeDagModal } from "./dagmodalstate";

// graph header: back, the owning run's goal, the derived status pill, cancel. The graph
// lives in the Stage modal; back dismisses that modal.
export function DagGraphHeader({ group }: { group: TaskGroup }) {
    const status = group.status;
    const tone =
        status === "done" || status === "awaiting-review"
            ? "border-success/50 bg-success/10 text-success"
            : status === "blocked" || status === "awaiting-plan"
              ? "border-warning/60 bg-warning/10 text-warning"
              : status === "cancelled"
                ? "border-edge-mid bg-surface-raised text-muted"
                : "border-accent/50 bg-accent/10 text-accent-soft";
    const label = status.split("-").join(" ");
    return (
        <div className="flex items-center gap-3 border-b border-border bg-background px-4 py-2.5">
            <button
                type="button"
                onClick={closeDagModal}
                className="rounded border border-edge-mid px-2.5 py-1 text-[11.5px] font-semibold text-secondary hover:border-edge-strong"
            >
                ← Back
            </button>
            <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-bold tracking-[-0.01em] text-primary">
                    {group.title || "orchestration dag"}
                </div>
                <div className="font-mono text-[10px] text-muted">
                    {group.id} · parallelism {group.parallelism} ·{" "}
                    {group.tasks.filter((t) => t.state === "done").length}/{group.tasks.length} done
                </div>
            </div>
            <span className={`rounded-[5px] border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide ${tone}`}>
                {label}
            </span>
            {/* awaiting-plan is cancellable too: abandoning a run at its gate is a normal answer, and the
                alternative would be approving work you do not want in order to be allowed to stop it */}
            {group.status === "running" || group.status === "awaiting-review" || group.status === "awaiting-plan" ? (
                <button
                    type="button"
                    onClick={() =>
                        void RpcApi.DagActionCommand(TabRpcClient, {
                            channelid: group.channelid,
                            runid: group.runid,
                            taskid: "",
                            action: "cancel",
                        })
                    }
                    className="rounded border border-edge-mid px-2.5 py-1 text-[11.5px] font-semibold text-secondary hover:border-warning/60 hover:text-warning"
                >
                    Cancel
                </button>
            ) : null}
        </div>
    );
}
