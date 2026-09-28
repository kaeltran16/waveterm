// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"sort"
	"sync"
)

// stages counts the background stages the engine runs off a tick, by name. Tests wait until none is running
// before they restore the hooks a stage calls, so no stage lands in the next test's fakes. A named count, not
// a sync.WaitGroup: a wait that times out can say what is still running, and never races a stage's Add.
var stages = struct {
	sync.Mutex
	running map[string]int
}{running: make(map[string]int)}

// goStage runs fn on its own goroutine as the named background stage.
func goStage(name string, fn func()) {
	stages.Lock()
	stages.running[name]++
	stages.Unlock()
	go func() {
		defer func() {
			stages.Lock()
			stages.running[name]--
			if stages.running[name] == 0 {
				delete(stages.running, name)
			}
			stages.Unlock()
		}()
		fn()
	}()
}

// runningStages names the stages still running, sorted.
func runningStages() []string {
	stages.Lock()
	defer stages.Unlock()
	names := make([]string, 0, len(stages.running))
	for name := range stages.running {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
