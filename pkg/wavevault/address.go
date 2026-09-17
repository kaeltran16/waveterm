// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

// Address is the cockpit's navigation address for a vault node, plus the sub-object to land on within it.
// A decision has no surface of its own — the frontend renders it inside its parent record's thread — so it
// addresses that record and names itself as the anchor. parent finds the record; when it finds none the
// address is dropped rather than faked, because an Open that lands on a record id that does not exist is
// worse than no Open at all.
func Address(collection, id string, parent func(decisionID string) string) (address, anchor string) {
	switch collection {
	case CollTasks:
		return "task:" + id, ""
	case CollMemory:
		return "memnote:" + id, ""
	case CollDecisions:
		owner := ""
		if parent != nil {
			owner = parent(id)
		}
		if owner == "" {
			return "", ""
		}
		return "task:" + owner, id
	default:
		return "", ""
	}
}

// ParentRecord is the task record whose refs wikilink decisionID; AppendDecision writes that link on both
// sides. It reads this retriever's loaded graph, so a caller addressing many decisions reads the vault once.
// Empty when the scope holds no such record or the vault cannot be read.
func (r *Retriever) ParentRecord(decisionID string) string {
	owners, err := r.Query(Filter{HasLink: decisionID})
	if err != nil {
		return ""
	}
	for _, n := range owners {
		if n.Collection == CollTasks {
			return n.ID
		}
	}
	return ""
}
