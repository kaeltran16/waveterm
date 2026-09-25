// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package utilfn

import (
	"encoding/json"

	"github.com/mitchellh/mapstructure"
)

func ReUnmarshal(out any, in any) error {
	barr, err := json.Marshal(in)
	if err != nil {
		return err
	}
	return json.Unmarshal(barr, out)
}

// does a mapstructure using "json" tags
func DoMapStructure(out any, input any) error {
	dconfig := &mapstructure.DecoderConfig{
		Result:  out,
		TagName: "json",
	}
	decoder, err := mapstructure.NewDecoder(dconfig)
	if err != nil {
		return err
	}
	return decoder.Decode(input)
}
