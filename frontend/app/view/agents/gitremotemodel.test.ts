// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { fetchButton, pushButton, remoteButtonsShown, remoteFailureBanner, type RemoteFacts } from "./gitremotemodel";
import { GIT_REMOTE_IDLE, type GitRemoteState } from "./gitremotestore";

const NOW = 1_700_000_000_000;
const facts = (f: Partial<RemoteFacts> = {}): RemoteFacts => ({
    branch: "feat",
    hasRemote: true,
    upstream: "origin/feat",
    ahead: 0,
    behind: 0,
    ...f,
});
const st = (s: Partial<GitRemoteState> = {}): GitRemoteState => ({ ...GIT_REMOTE_IDLE, ...s });
const REJECTED = {
    command: "git push",
    exitcode: 1,
    stderr: " ! [rejected]        feat -> feat (fetch first)\nerror: failed to push some refs to 'x'",
};
const AUTH = { command: "git push", exitcode: 128, stderr: "fatal: Authentication failed for 'x'" };

describe("pushButton", () => {
    it("counts the commits ahead and names the upstream", () => {
        expect(pushButton(facts({ ahead: 2 }), st(), NOW)).toEqual({
            label: "Push",
            icon: "push",
            title: "Push 2 commits to origin/feat",
            disabled: false,
            publish: false,
            detail: { kind: "ahead", ahead: 2, behind: 0 },
        });
        expect(pushButton(facts({ ahead: 1 }), st(), NOW).title).toBe("Push 1 commit to origin/feat");
    });

    it("says diverged when the upstream has commits this branch lacks", () => {
        const b = pushButton(facts({ ahead: 2, behind: 1 }), st(), NOW);
        expect(b.title).toBe("origin/feat has 1 commit you lack: merge before pushing");
        expect(b.detail).toEqual({ kind: "ahead", ahead: 2, behind: 1 });
        expect(b.disabled).toBe(false);
        expect(pushButton(facts({ ahead: 1, behind: 3 }), st(), NOW).title).toBe(
            "origin/feat has 3 commits you lack: merge before pushing"
        );
    });

    it("has nothing to push and no detail when nothing is ahead and no push was made", () => {
        const b = pushButton(facts(), st(), NOW);
        expect(b.title).toBe("Nothing to push: origin/feat has every commit");
        expect(b.detail).toBeNull();
        expect(b.label).toBe("Push");
    });

    it("shows the push time once a push left nothing ahead", () => {
        expect(pushButton(facts(), st({ pushedAt: NOW / 1000 - 5 }), NOW).detail).toEqual({
            kind: "time",
            text: "just now",
        });
        expect(pushButton(facts(), st({ pushedAt: NOW / 1000 - 180 }), NOW).detail).toEqual({
            kind: "time",
            text: "3m ago",
        });
    });

    it("publishes a branch with no upstream", () => {
        expect(pushButton(facts({ upstream: "" }), st(), NOW)).toEqual({
            label: "Publish",
            icon: "push",
            title: "Publish feat to origin and track it",
            disabled: false,
            publish: true,
            detail: null,
        });
    });

    it("is disabled on a detached HEAD, which is not Publish", () => {
        for (const branch of ["", "HEAD"]) {
            expect(pushButton(facts({ branch, upstream: "" }), st(), NOW)).toEqual({
                label: "Push",
                icon: "push",
                title: "HEAD is detached: check out a branch to push",
                disabled: true,
                publish: false,
                detail: null,
            });
        }
    });

    it("spins while it runs, with no detail", () => {
        const b = pushButton(facts({ ahead: 2 }), st({ running: "push" }), NOW);
        expect(b).toMatchObject({ label: "Pushing…", icon: "running", disabled: true, detail: null });
        expect(pushButton(facts({ upstream: "" }), st({ running: "push" }), NOW).label).toBe("Publishing…");
    });

    it("is held by a running fetch, keeping its own look", () => {
        expect(pushButton(facts({ ahead: 2 }), st({ running: "fetch" }), NOW)).toEqual({
            label: "Push",
            icon: "push",
            title: "Push 2 commits to origin/feat",
            disabled: true,
            publish: false,
            detail: { kind: "ahead", ahead: 2, behind: 0 },
        });
    });

    it("shows its failure in place of its icon, and only its own", () => {
        const failedPush = st({ failure: { action: "push", git: REJECTED } });
        expect(pushButton(facts({ ahead: 2 }), failedPush, NOW)).toMatchObject({
            label: "Push",
            icon: "failed",
            disabled: false,
            detail: { kind: "ahead", ahead: 2, behind: 0 },
        });
        expect(pushButton(facts({ ahead: 2 }), st({ failure: { action: "fetch", git: AUTH } }), NOW).icon).toBe("push");
    });
});

describe("fetchButton", () => {
    it("reads idle with no clock before any fetch", () => {
        expect(fetchButton(st(), NOW)).toEqual({
            label: "Fetch",
            icon: "fetch",
            title: "Update remote-tracking refs",
            disabled: false,
            detail: "",
        });
    });

    it("carries the last fetch time inside the button", () => {
        expect(fetchButton(st({ fetchedAt: NOW / 1000 }), NOW).detail).toBe("just now");
    });

    it("spins while it runs and is held by a running push", () => {
        expect(fetchButton(st({ running: "fetch", fetchedAt: NOW / 1000 }), NOW)).toMatchObject({
            label: "Fetching…",
            icon: "running",
            disabled: true,
            detail: "",
        });
        expect(fetchButton(st({ running: "push" }), NOW)).toMatchObject({ label: "Fetch", disabled: true });
    });

    it("shows its failure in place of its icon", () => {
        expect(fetchButton(st({ failure: { action: "fetch", git: AUTH } }), NOW).icon).toBe("failed");
        expect(fetchButton(st({ failure: { action: "push", git: AUTH } }), NOW).icon).toBe("fetch");
    });
});

describe("remoteButtonsShown", () => {
    it("draws Fetch only in compare and Push on every range, both only with a remote", () => {
        expect(remoteButtonsShown(facts(), true)).toEqual({ fetch: true, push: true });
        expect(remoteButtonsShown(facts(), false)).toEqual({ fetch: false, push: true });
        expect(remoteButtonsShown(facts({ hasRemote: false }), true)).toEqual({ fetch: false, push: false });
        expect(remoteButtonsShown(null, true)).toEqual({ fetch: false, push: false });
    });
});

describe("remoteFailureBanner", () => {
    it("is absent with no failure", () => {
        expect(remoteFailureBanner(facts(), st())).toBeNull();
    });

    it("names the upstream in a rejected push's note", () => {
        expect(remoteFailureBanner(facts(), st({ failure: { action: "push", git: REJECTED } }))).toEqual({
            action: "push",
            title: "Push failed",
            note: "origin/feat has commits you lack. Fetch, then merge them before pushing.",
            failure: REJECTED,
        });
    });

    it("says nothing was pushed for any other push failure, Publish included", () => {
        expect(remoteFailureBanner(facts(), st({ failure: { action: "push", git: AUTH } }))?.note).toBe(
            "nothing was pushed"
        );
        expect(
            remoteFailureBanner(facts({ upstream: "" }), st({ failure: { action: "push", git: AUTH } }))?.title
        ).toBe("Push failed");
    });

    it("keeps Fetch's text", () => {
        expect(remoteFailureBanner(facts(), st({ failure: { action: "fetch", git: AUTH } }))).toEqual({
            action: "fetch",
            title: "Fetch failed",
            note: "showing refs as of the last fetch",
            failure: AUTH,
        });
    });
});
