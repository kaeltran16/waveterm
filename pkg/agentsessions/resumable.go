// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsessions

// DirCheck decides whether sessions can resume in their recorded working directory: a resume from any other
// dir cannot find a claude session (claude looks it up by the cwd's project slug). It stats each distinct
// path once, so make one per call, never one for the process: a dir can come back.
type DirCheck struct {
	stat     func(string) error
	blockers map[string]string
}

func NewDirCheck(stat func(string) error) *DirCheck {
	return &DirCheck{stat: stat, blockers: map[string]string{}}
}

// Blocker is "" when projectPath exists, else why a session recorded there cannot resume.
func (c *DirCheck) Blocker(projectPath string) string {
	if projectPath == "" {
		return "no working directory was recorded"
	}
	if b, ok := c.blockers[projectPath]; ok {
		return b
	}
	var b string
	if c.stat(projectPath) != nil {
		b = "its working directory " + projectPath + " no longer exists"
	}
	c.blockers[projectPath] = b
	return b
}
