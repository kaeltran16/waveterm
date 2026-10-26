// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package workflowscan

import "fmt"

// arcProject is the repo that holds Arc's own prompts: the engine's, the plan review's and the skills'.
const arcProject = "waveterm"

// PicksLine is what the agent is typed when the owner's picks are stored.
const PicksLine = "workflow-scan: the owner's picks are in; read them with wsh workflow picks"

const goalTemplate = `Workflow scan

You are a workflow scan for the project %[1]q. Code has read the last %[2]d days of Arc's run records across every
project, had a model name the problems that recur, and recounted them against the records. Your job is to judge each
surviving pattern against the current files, draft a small fix for the ones still open, and apply only the fixes the
owner picks. Work in this repo only.

1. Read the survivors: run ` + "`wsh workflow scan --window %[2]d`" + `. It prints each survivor (id, title, fix target,
   verified runs and days, projects, a quote per run with its run id), then the patterns under the 3-run floor,
   which are for context only. It takes a few minutes. If it fails, report why with wsh jarvis complete and stop.

2. Check each survivor against the current files and docs/deferred.md:
   - If a file or commit already addresses it, it is "covered": say which in "note".
   - If docs/deferred.md holds a "Workflow scan:" entry declining the same problem, compare its "Verified runs at
     decline: N" with the survivor's runs now. Not above N: it is "declined", with "declinedat" N. Above N: suggest
     it again, with "declinedat" N.
   - Otherwise it is a "suggest".

3. Draft each suggest's fix: the smallest edit to the file that causes the problem, as +/- lines, 1 to 3 "+" lines
   and at most 3 "-" lines, nothing else. Name the "file" (its path in the repo it lives in), "where" (the symbol or
   section) and "fixproject", the project that holds the file. This scan's project is %[1]q. Fixes to Arc's own
   prompts (the engine, the plan review, the skills) live in the Arc repo %[3]q.

4. Write one verdict per survivor, every survivor exactly once, to a JSON file shaped
   {"verdicts":[{"id","verdict","note","file","where","fixproject","edit","declinedat"}]}
   where verdict is suggest, covered or declined and the edit holds its lines joined by "\n". Send it with
   ` + "`wsh workflow result <file>`" + `. The server refuses a result that breaks these rules and says why; fix the file
   and resend it. With no suggest verdict there is nothing to pick: complete now, with
   ` + "`wsh jarvis complete --report <file>`" + `, and stop.

5. Wait idle for the owner's picks: they arrive as the line
   %[4]q
   Do not poll. Then run ` + "`wsh workflow picks`" + `, which prints each pick with its verdict.
   - apply: make the drafted edit in this repo.
   - drop: add a Declined entry to docs/deferred.md in this repo, creating the file if the repo has none, as its
     own section:

     ## Workflow scan: <pattern, one line> (declined YYYY-MM-DD)

     <owner's reason>. Fix target: <file>. Verified runs at decline: N. Raise again only above N.

   - A suggestion with no pick is left alone: not applied, not declined.

6. Commit only the files you changed, with a ` + "`chore(workflow): <summary>`" + ` subject, and complete with
   ` + "`wsh jarvis complete --commit <sha> --report <file>`" + `; leave out --commit when nothing was committed. The
   report lists each pick and what you did with it.
`

// Goal is the scan run's instructions, built in so the owner never retypes them.
func Goal(project string, windowDays int) string {
	return fmt.Sprintf(goalTemplate, project, windowDays, arcProject, PicksLine)
}
