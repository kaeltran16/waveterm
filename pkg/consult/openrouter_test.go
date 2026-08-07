// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package consult

import (
	"strings"
	"testing"
)

func TestOpenrouterModelDefaults(t *testing.T) {
	if m := "deepseek/deepseek-v4-flash"; OpenrouterCheapModel() != m {
		t.Logf("OpenrouterCheapModel: got %q, expected %q (when no config set)", OpenrouterCheapModel(), m)
	}
	if m := "deepseek/deepseek-v4-pro"; OpenrouterMidModel() != m {
		t.Logf("OpenrouterMidModel: got %q, expected %q (when no config set)", OpenrouterMidModel(), m)
	}
	if m := "deepseek/deepseek-v4-pro"; OpenrouterLongModel() != m {
		t.Logf("OpenrouterLongModel: got %q, expected %q (when no config set)", OpenrouterLongModel(), m)
	}
}

func TestCorpusModel_escalatesAtThreshold(t *testing.T) {
	cheap := "cheap-model"
	long := "long-model"
	if got := CorpusModel(cheap, long, ""); got != cheap {
		t.Fatalf("empty corpus: got %q, want %q", got, cheap)
	}
	under := strings.Repeat("x", CorpusEscalationBytes-1)
	if got := CorpusModel(cheap, long, under); got != cheap {
		t.Fatalf("under threshold: got %q, want %q", got, cheap)
	}
	atThreshold := strings.Repeat("x", CorpusEscalationBytes)
	if got := CorpusModel(cheap, long, atThreshold); got != long {
		t.Fatalf("at threshold: got %q, want %q", got, atThreshold)
	}
}
