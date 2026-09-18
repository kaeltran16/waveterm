// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import (
	"context"
	"reflect"
	"testing"
)

type testRpcInterfaceForDecls interface {
	NoArgCommand(ctx context.Context) error
	OneArgCommand(ctx context.Context, data string) error
	TwoArgCommand(ctx context.Context, arg1 string, arg2 int) error
}

func TestGenerateWshCommandDecl_MultiArgs(t *testing.T) {
	rtype := reflect.TypeOf((*testRpcInterfaceForDecls)(nil)).Elem()
	method, ok := rtype.MethodByName("TwoArgCommand")
	if !ok {
		t.Fatalf("TwoArgCommand method not found")
	}
	decl := generateWshCommandDecl(method)
	if decl.Command != "twoarg" {
		t.Fatalf("expected command twoarg, got %q", decl.Command)
	}
	if len(decl.CommandDataTypes) != 2 {
		t.Fatalf("expected 2 command data types, got %d", len(decl.CommandDataTypes))
	}
	if decl.CommandDataTypes[0].Kind() != reflect.String || decl.CommandDataTypes[1].Kind() != reflect.Int {
		t.Fatalf("unexpected command data types: %#v", decl.CommandDataTypes)
	}
	if len(decl.GetCommandDataTypes()) != 2 {
		t.Fatalf("expected helper to return two command data types")
	}
}

func TestGenerateWshCommandDeclMap_TestMultiArgCommand(t *testing.T) {
	decl := GenerateWshCommandDeclMap()["testmultiarg"]
	if decl == nil {
		t.Fatalf("expected testmultiarg command declaration")
	}
	if decl.MethodName != "TestMultiArgCommand" {
		t.Fatalf("expected TestMultiArgCommand method name, got %q", decl.MethodName)
	}
	if len(decl.GetCommandDataTypes()) != 3 {
		t.Fatalf("expected 3 command args, got %d", len(decl.GetCommandDataTypes()))
	}
}

func TestUiCommandsAreDeclared(t *testing.T) {
	decls := GenerateWshCommandDeclMap()
	want := map[string]reflect.Type{
		"uistate":  reflect.TypeOf((*UiState)(nil)),
		"uireveal": reflect.TypeOf(""),
		"uiinvoke": reflect.TypeOf(""),
	}
	for cmd, rtnType := range want {
		decl, ok := decls[cmd]
		if !ok {
			t.Fatalf("command %q not declared", cmd)
		}
		if decl.CommandType != RpcType_Call {
			t.Errorf("%s: command type %q, want %q", cmd, decl.CommandType, RpcType_Call)
		}
		if decl.DefaultResponseDataType != rtnType {
			t.Errorf("%s: response type %v, want %v", cmd, decl.DefaultResponseDataType, rtnType)
		}
	}
}
