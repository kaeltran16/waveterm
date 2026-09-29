// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package waveobj

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestModelFields(t *testing.T) {
	in := TaskGroup{
		ID:            "g1",
		ReviewerPicks: true,
		ReviewerRoute: &RoutePin{Runtime: "claude", Model: "sonnet"},
		Tasks: []TaskNode{{
			ID:          "t-1",
			State:       "pending",
			RunSpec:     RunSpec{Runtime: "claude", Model: "sonnet"},
			ModelSource: TaskModelSource_Reviewer,
			PickReason:  "mechanical",
		}},
	}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{`"reviewerpicks":true`, `"reviewerroute":`, `"modelsource":"reviewer"`, `"pickreason":"mechanical"`} {
		if !strings.Contains(string(b), key) {
			t.Errorf("marshaled group lacks %s: %s", key, b)
		}
	}
	var out TaskGroup
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(in, out) {
		t.Errorf("round trip changed the group:\n in=%+v\nout=%+v", in, out)
	}

	zero, err := json.Marshal(TaskGroup{Tasks: []TaskNode{{ID: "t-1"}}})
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"reviewerpicks", "reviewerroute", "modelsource", "pickreason"} {
		if strings.Contains(string(zero), `"`+key+`"`) {
			t.Errorf("zero group marshals %q, which changes stored objects: %s", key, zero)
		}
	}
}
