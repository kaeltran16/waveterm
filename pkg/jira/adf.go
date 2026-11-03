// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jira

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// adfNode is one node of an Atlassian Document Format tree.
type adfNode struct {
	Type    string         `json:"type"`
	Text    string         `json:"text,omitempty"`
	Attrs   map[string]any `json:"attrs,omitempty"`
	Content []adfNode      `json:"content,omitempty"`
}

const (
	bulletMarker   = "- "
	listIndent     = "  "
	blockSeparator = "\n\n"
)

var inlineTypes = map[string]bool{
	"text": true, "hardBreak": true, "mention": true, "emoji": true, "inlineCard": true,
	"date": true, "status": true, "mediaInline": true,
}

// parseADF reads an ADF doc, turning each embedded media node into a text marker that names the
// attachment it shows (see mediaMarker).
func parseADF(doc json.RawMessage, atts []wshrpc.JiraAttachment) (adfNode, bool) {
	var n adfNode
	if len(doc) == 0 || json.Unmarshal(doc, &n) != nil || n.Type == "" {
		return adfNode{}, false
	}
	markMedia(&n, atts)
	return n, true
}

func markMedia(n *adfNode, atts []wshrpc.JiraAttachment) {
	if n.Type == "media" || n.Type == "mediaInline" {
		*n = adfNode{Type: "text", Text: mediaMarker(*n, atts)}
		return
	}
	for i := range n.Content {
		markMedia(&n.Content[i], atts)
	}
}

// mediaMarker says where a doc embedded a file: "[image: shot.png (attachment 10001)]". Jira sets a
// media node's alt to the file's name; its id is a Media Services id that REST never maps to an
// attachment id, so the name is the only link. Two attachments sharing the name are both listed.
func mediaMarker(n adfNode, atts []wshrpc.JiraAttachment) string {
	if attrString(n, "type") == "external" {
		if u := attrString(n, "url"); u != "" {
			return "[image: " + u + "]"
		}
		return "[image]"
	}
	alt := strings.TrimSpace(attrString(n, "alt"))
	if alt == "" {
		return "[image]"
	}
	kind := "image"
	var ids []string
	for _, a := range atts {
		if a.Filename != alt {
			continue
		}
		ids = append(ids, a.ID)
		if a.MimeType != "" && !strings.HasPrefix(a.MimeType, "image/") {
			kind = "file"
		}
	}
	if len(ids) == 0 {
		return "[" + kind + ": " + alt + "]"
	}
	return fmt.Sprintf("[%s: %s (attachment %s)]", kind, alt, strings.Join(ids, " or "))
}

// ADFToPlain renders an ADF document as readable plain text, marking embedded media with the
// attachment from atts it shows. A node type it doesn't know yields its text children, so a new Jira
// node never hides content or fails the read. A JSON string (a plain text field) comes back as is.
func ADFToPlain(doc json.RawMessage, atts []wshrpc.JiraAttachment) string {
	n, ok := parseADF(doc, atts)
	if !ok {
		var s string
		if json.Unmarshal(doc, &s) == nil {
			return strings.TrimSpace(s)
		}
		return ""
	}
	return strings.TrimSpace(blockText(n, ""))
}

func blockText(n adfNode, indent string) string {
	switch n.Type {
	case "paragraph", "heading", "codeBlock":
		return inlineText(n.Content)
	case "bulletList", "orderedList":
		return listText(n, indent)
	case "rule":
		return "---"
	case "table":
		return joinBlocks(n.Content, indent, "\n")
	case "tableRow":
		return joinBlocks(n.Content, indent, " | ")
	case "tableCell", "tableHeader", "listItem":
		return joinBlocks(n.Content, indent, " ")
	case "mediaSingle", "mediaGroup":
		return joinBlocks(n.Content, indent, "\n")
	}
	if inlineTypes[n.Type] {
		return inlineText([]adfNode{n})
	}
	if n.Text != "" {
		return n.Text
	}
	if allInline(n.Content) {
		return inlineText(n.Content)
	}
	return joinBlocks(n.Content, indent, blockSeparator)
}

func allInline(nodes []adfNode) bool {
	for _, c := range nodes {
		if !inlineTypes[c.Type] {
			return false
		}
	}
	return true
}

func joinBlocks(nodes []adfNode, indent, sep string) string {
	parts := make([]string, 0, len(nodes))
	for _, c := range nodes {
		if s := blockText(c, indent); s != "" {
			parts = append(parts, s)
		}
	}
	return strings.Join(parts, sep)
}

func listText(n adfNode, indent string) string {
	start := 1
	if order, ok := n.Attrs["order"].(float64); ok {
		start = int(order)
	}
	lines := make([]string, 0, len(n.Content))
	for i, item := range n.Content {
		marker := bulletMarker
		if n.Type == "orderedList" {
			marker = fmt.Sprintf("%d. ", start+i)
		}
		lines = append(lines, indent+marker+listItemText(item, indent+listIndent))
	}
	return strings.Join(lines, "\n")
}

// listItemText puts the item's first paragraph after the marker and any nested list on the lines below.
func listItemText(item adfNode, indent string) string {
	parts := make([]string, 0, len(item.Content))
	for _, c := range item.Content {
		if s := blockText(c, indent); s != "" {
			parts = append(parts, s)
		}
	}
	return strings.Join(parts, "\n")
}

func inlineText(nodes []adfNode) string {
	var b strings.Builder
	for _, n := range nodes {
		switch n.Type {
		case "text":
			b.WriteString(n.Text)
		case "hardBreak":
			b.WriteString("\n")
		case "mention", "status":
			b.WriteString(attrString(n, "text"))
		case "emoji":
			if s := attrString(n, "text"); s != "" {
				b.WriteString(s)
			} else {
				b.WriteString(attrString(n, "shortName"))
			}
		case "inlineCard":
			b.WriteString(attrString(n, "url"))
		case "date":
			b.WriteString(dateText(attrString(n, "timestamp")))
		default:
			if n.Text != "" {
				b.WriteString(n.Text)
			} else {
				b.WriteString(inlineText(n.Content))
			}
		}
	}
	return b.String()
}

func attrString(n adfNode, key string) string {
	s, _ := n.Attrs[key].(string)
	return s
}

// dateText renders an ADF date node's epoch-millis timestamp as a calendar date.
func dateText(ms string) string {
	var v int64
	if _, err := fmt.Sscan(ms, &v); err != nil {
		return ms
	}
	return time.UnixMilli(v).UTC().Format("2006-01-02")
}

// listItems returns the text of every top-level item of the first list at or after blocks[from].
func listItems(blocks []adfNode, from int) []string {
	for _, b := range blocks[from:] {
		if b.Type != "bulletList" && b.Type != "orderedList" {
			continue
		}
		items := make([]string, 0, len(b.Content))
		for _, item := range b.Content {
			if s := strings.TrimSpace(firstBlockText(item)); s != "" {
				items = append(items, s)
			}
		}
		return items
	}
	return nil
}

func firstBlockText(item adfNode) string {
	for _, c := range item.Content {
		if c.Type != "bulletList" && c.Type != "orderedList" {
			return blockText(c, "")
		}
	}
	return ""
}

// PlainToADF turns plain text into an ADF doc: blank-line-separated blocks are paragraphs (a single
// newline is a hard break), runs of "- " lines are one bullet list, and a line that leads straight
// into a list without ending a sentence ("Done", "In progress") is a bold section title.
func PlainToADF(plain string) map[string]any {
	content := []any{}
	for _, block := range strings.Split(strings.ReplaceAll(plain, "\r\n", "\n"), blockSeparator) {
		content = append(content, plainBlockToADF(strings.Split(block, "\n"))...)
	}
	return map[string]any{"type": "doc", "version": 1, "content": content}
}

func plainBlockToADF(lines []string) []any {
	var out []any
	var para []string
	var items []string
	flushPara := func() {
		if len(para) > 0 {
			out = append(out, adfParagraph(para))
			para = nil
		}
	}
	flushList := func() {
		if len(items) > 0 {
			out = append(out, adfBulletList(items))
			items = nil
		}
	}
	for i, raw := range lines {
		line := strings.TrimRight(raw, " \t")
		if strings.TrimSpace(line) == "" {
			continue
		}
		if strings.HasPrefix(line, bulletMarker) {
			flushPara()
			items = append(items, strings.TrimSpace(line[len(bulletMarker):]))
			continue
		}
		flushList()
		if isSectionTitle(line, lines[i+1:]) {
			flushPara()
			out = append(out, adfStrong(line))
			continue
		}
		para = append(para, line)
	}
	flushPara()
	flushList()
	return out
}

func isSectionTitle(line string, rest []string) bool {
	if len(rest) == 0 || !strings.HasPrefix(rest[0], bulletMarker) {
		return false
	}
	return !strings.ContainsAny(line[len(line)-1:], ".!?")
}

func adfTextNode(s string) map[string]any {
	return map[string]any{"type": "text", "text": s}
}

func adfParagraph(lines []string) map[string]any {
	content := make([]any, 0, 2*len(lines)-1)
	for i, l := range lines {
		if i > 0 {
			content = append(content, map[string]any{"type": "hardBreak"})
		}
		content = append(content, adfTextNode(l))
	}
	return map[string]any{"type": "paragraph", "content": content}
}

func adfStrong(s string) map[string]any {
	text := adfTextNode(s)
	text["marks"] = []any{map[string]any{"type": "strong"}}
	return map[string]any{"type": "paragraph", "content": []any{text}}
}

func adfBulletList(items []string) map[string]any {
	lis := make([]any, 0, len(items))
	for _, it := range items {
		para := []any{}
		if it != "" {
			para = []any{adfTextNode(it)}
		}
		lis = append(lis, map[string]any{"type": "listItem", "content": []any{map[string]any{"type": "paragraph", "content": para}}})
	}
	return map[string]any{"type": "bulletList", "content": lis}
}
