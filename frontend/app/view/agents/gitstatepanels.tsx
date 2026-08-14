// frontend/app/view/agents/gitstatepanels.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The two repository states that take over the whole Diff surface. They are deliberately different
// screens: "not a repository" is a calm fact about the source you picked, while "the read failed" is
// a fault worth acting on, so it carries the failing command, its exit code, stderr verbatim, and a
// retry. Collapsing them into one banner is the failure mode the design brief called out.

export function NotARepoPanel() {
    return (
        <div data-not-a-repo className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[10px] px-[40px]">
            <div className="text-[14px] font-semibold text-ink-hi">This source is not a Git repository</div>
            <div className="max-w-[520px] text-center text-[12.5px] leading-[1.6] text-ink-mid">
                There is no history to read here. Pick a different repository or agent with the scope control above.
            </div>
        </div>
    );
}

export function GitFailurePanel({ failure, onRetry }: { failure: GitFailure; onRetry: () => void }) {
    // -1 means the failure was not an exit status at all (git missing, a timeout, a dropped socket).
    // Showing "no exit code" beats printing -1 as though git had returned it.
    const code = failure.exitcode < 0 ? "no exit code" : `exit ${failure.exitcode}`;
    return (
        <div data-git-failure className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[12px] px-[40px]">
            <div className="text-[14px] font-semibold text-error">Couldn’t read this repository</div>
            <div className="max-w-[560px] text-center text-[12.5px] leading-[1.6] text-ink-mid">
                The repository exists — the read failed. Nothing has been changed, so retrying is worth doing.
            </div>
            <div className="w-full max-w-[720px] rounded-[8px] border border-edge-mid bg-surface-code px-[12px] py-[10px]">
                <div className="flex items-center gap-[8px] pb-[6px]">
                    <span className="font-mono text-xxxs font-bold uppercase tracking-[0.1em] text-ink-faint">
                        Command
                    </span>
                    <span className="min-w-0 flex-1 select-text truncate font-mono text-[11.5px] text-ink-mid">
                        {failure.command}
                    </span>
                    <span className="flex-none rounded-[5px] border border-error/25 bg-error/12 px-[7px] py-[2px] font-mono text-[9.5px] font-semibold text-error">
                        {code}
                    </span>
                </div>
                {failure.stderr ? (
                    <pre className="max-h-[220px] select-text overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[1.5] text-ink-mid">
                        {failure.stderr}
                    </pre>
                ) : null}
            </div>
            <button
                data-git-failure-retry
                onClick={onRetry}
                className="rounded-[7px] border border-edge-mid bg-surface-raised px-[12px] py-[6px] text-[11.5px] font-semibold text-ink-mid hover:border-edge-strong hover:text-foreground"
            >
                Retry
            </button>
        </div>
    );
}
