// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentask

import (
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

// ValidateAnswers reports whether answers can be delivered to an ask's questions: the one rule set the
// encoder and any caller that must vet an answer before claiming the ask (DeliverAnswer claims first, so a
// bad answer would burn the claim) share. One answer per question; each is picks xor single-line text;
// single-select takes exactly one pick and multi-select at least one, all in range; a preview question has
// no free-text row in a batch. prose is a projected bare-prose ask, which has no picker: exactly one
// question and answer, text or one pick.
func ValidateAnswers(questions []baseds.AgentAskQuestion, answers []baseds.AgentAnswerItem, prose bool) error {
	if len(questions) == 0 {
		return fmt.Errorf("no questions to answer")
	}
	if prose {
		return validateProse(questions, answers)
	}
	if len(answers) != len(questions) {
		return fmt.Errorf("expected %d answers, got %d", len(questions), len(answers))
	}
	batch := len(questions) > 1
	for i, q := range questions {
		if err := validateAnswer(q, answers[i], batch); err != nil {
			if batch {
				return fmt.Errorf("question %d: %w", i, err)
			}
			return err
		}
	}
	return nil
}

func validateProse(questions []baseds.AgentAskQuestion, answers []baseds.AgentAnswerItem) error {
	if len(questions) != 1 {
		return fmt.Errorf("prose ask expects exactly one question, got %d", len(questions))
	}
	if len(answers) != 1 {
		return fmt.Errorf("prose ask expects exactly one answer, got %d", len(answers))
	}
	a := answers[0]
	if a.Text != "" {
		if len(a.SelectedIndexes) > 0 {
			return fmt.Errorf("answer has both text and selected indexes")
		}
		return validateFreeText(a.Text)
	}
	if len(a.SelectedIndexes) != 1 {
		return fmt.Errorf("prose answer must be text or a single option index")
	}
	return validateIndex(a.SelectedIndexes[0], len(questions[0].Options))
}

func validateAnswer(q baseds.AgentAskQuestion, a baseds.AgentAnswerItem, batch bool) error {
	if a.Text != "" {
		if len(a.SelectedIndexes) > 0 {
			return fmt.Errorf("answer has both text and selected indexes")
		}
		if err := validateFreeText(a.Text); err != nil {
			return err
		}
		if batch && previewLayout(q) {
			return fmt.Errorf("question shows previews, so its picker has no free-text row: pick an option")
		}
		return nil
	}
	if q.MultiSelect {
		_, err := sortedUniqueIndexes(a.SelectedIndexes, len(q.Options))
		return err
	}
	if len(a.SelectedIndexes) != 1 {
		return fmt.Errorf("single-select expects exactly one selected index, got %d", len(a.SelectedIndexes))
	}
	return validateIndex(a.SelectedIndexes[0], len(q.Options))
}

func validateIndex(idx, nOpts int) error {
	if idx < 0 || idx >= nOpts {
		return fmt.Errorf("selected index %d out of range (%d options)", idx, nOpts)
	}
	return nil
}
