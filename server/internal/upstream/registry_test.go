// SPDX-License-Identifier: AGPL-3.0-only
package upstream

import (
	"encoding/json"
	"testing"
)

func boolptr(v bool) *bool { return &v }
func intptr(v int) *int    { return &v }

func TestCapabilitiesRequireExactModelAndMatchingProtocol(t *testing.T) {
	for _, tc := range []struct{ adapter, protocol, id, family string }{
		{"standard", "openai-chat", "o3", "openai"},
		{"standard", "openai-responses", "gpt-5", "openai"},
		{"standard", "anthropic", "claude-sonnet-4-5-20250929", "claude"},
		{"standard", "gemini", "gemini-2.5-pro", "gemini"},
		{"deepseek", "openai-chat", "deepseek-reasoner", "deepseek"},
		{"qwen", "openai-chat", "qwen-plus", "qwen"},
		{"kimi", "openai-chat", "kimi-k2.5", "kimi"},
		{"glm", "openai-chat", "glm-4.6", "glm"},
		{"openrouter", "openai-chat", "anthropic/claude-sonnet-4.5", "claude"},
		{"siliconflow", "openai-chat", "Qwen/Qwen3-235B-A22B", "qwen"},
	} {
		t.Run(tc.id, func(t *testing.T) {
			c := Capabilities(tc.adapter, tc.protocol, tc.id)
			if !c.Known || c.Family != tc.family || len(c.Sources) == 0 || c.OutputMax <= 0 {
				t.Fatalf("missing verified capability: %+v", c)
			}
		})
	}
	for _, tc := range []struct{ adapter, protocol, id string }{{"standard", "openai-chat", "my-o3-clone"}, {"standard", "anthropic", "gpt-5"}, {"standard", "openai-chat", "claude-sonnet-4-5"}, {"openrouter", "openai-chat", "unknown/claude-sonnet-4.5"}} {
		if Capabilities(tc.adapter, tc.protocol, tc.id).Known {
			t.Fatalf("inferred capability: %+v", tc)
		}
	}
}

func TestReasoningValidationRejectsUnsupportedAndConflictingSettings(t *testing.T) {
	for _, tc := range []struct {
		name, adapter, protocol, id string
		r                           Reasoning
		max                         int
	}{
		{"unknown", "standard", "openai-chat", "custom", Reasoning{Effort: "high"}, 4096},
		{"mandatory", "standard", "openai-chat", "o3", Reasoning{Enabled: boolptr(false)}, 4096},
		{"effort", "standard", "openai-chat", "o3", Reasoning{Effort: "xhigh"}, 4096},
		{"small budget", "standard", "anthropic", "claude-sonnet-4-5", Reasoning{Enabled: boolptr(true), BudgetTokens: intptr(1023)}, 4096},
		{"budget output", "standard", "anthropic", "claude-sonnet-4-5", Reasoning{Enabled: boolptr(true), BudgetTokens: intptr(4096)}, 4096},
		{"disabled budget", "standard", "anthropic", "claude-sonnet-4-5", Reasoning{Enabled: boolptr(false), BudgetTokens: intptr(1024)}, 4096},
		{"disabled effort", "standard", "gemini", "gemini-2.5-flash", Reasoning{Enabled: boolptr(false), Effort: "high"}, 4096},
		{"output cap", "standard", "openai-chat", "o3", Reasoning{}, 100001},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if ValidateReasoning(Capabilities(tc.adapter, tc.protocol, tc.id), tc.r, tc.max) == nil {
				t.Fatal("accepted invalid parameters")
			}
		})
	}
	if err := ValidateReasoning(Capabilities("standard", "openai-chat", "custom"), Reasoning{}, 4096); err != nil {
		t.Fatal(err)
	}
	if err := ValidateReasoning(Capabilities("standard", "anthropic", "claude-sonnet-4-5"), Reasoning{Enabled: boolptr(true), BudgetTokens: intptr(1024)}, 4096); err != nil {
		t.Fatal(err)
	}
}

func TestTemplatesExposeUsableBuiltinsAndCustom(t *testing.T) {
	seen := map[string]bool{}
	for _, v := range Templates() {
		seen[v.ID] = true
		if v.Protocol == "" || v.Adapter == "" {
			t.Fatalf("incomplete template: %+v", v)
		}
	}
	for _, id := range []string{"openai", "openai-responses", "gemini", "anthropic", "openrouter", "siliconflow", "new-api", "one-api", "custom"} {
		if !seen[id] {
			t.Fatalf("missing %s", id)
		}
	}
}

func TestModelSpecificReasoningCombinations(t *testing.T) {
	for _, tc := range []struct {
		adapter, protocol, id string
		r                     Reasoning
		max                   int
		valid                 bool
	}{
		{"standard", "gemini", "gemini-2.5-pro", Reasoning{BudgetTokens: intptr(-1)}, 4096, true},
		{"standard", "gemini", "gemini-2.5-flash-lite", Reasoning{BudgetTokens: intptr(0)}, 4096, true},
		{"standard", "gemini", "gemini-2.5-flash", Reasoning{Enabled: boolptr(true), BudgetTokens: intptr(0)}, 4096, false},
		{"standard", "gemini", "gemini-2.5-pro", Reasoning{BudgetTokens: intptr(4096)}, 4096, false},
		{"standard", "anthropic", "claude-sonnet-4-5", Reasoning{Enabled: boolptr(true)}, 1024, false},
		{"openrouter", "openai-chat", "anthropic/claude-sonnet-4.5", Reasoning{Effort: "high", BudgetTokens: intptr(1024)}, 4096, false},
		{"standard", "anthropic", "claude-opus-4-5", Reasoning{Effort: "high", BudgetTokens: intptr(1024)}, 4096, true},
		{"standard", "anthropic", "claude-opus-4-7", Reasoning{Effort: "xhigh"}, 4096, true},
		{"standard", "anthropic", "claude-opus-5-5", Reasoning{Enabled: boolptr(false)}, 4096, false},
	} {
		t.Run(tc.id+tc.r.Effort, func(t *testing.T) {
			err := ValidateReasoning(Capabilities(tc.adapter, tc.protocol, tc.id), tc.r, tc.max)
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v err=%v", tc.valid, err)
			}
		})
	}
}

func TestClaudeEffortDisableConstraintsAreModelSpecific(t *testing.T) {
	for _, tc := range []struct {
		id, effort string
		valid      bool
	}{
		{"claude-sonnet-4-6", "max", true}, {"claude-opus-4-6", "max", true},
		{"claude-opus-4-7", "xhigh", true}, {"claude-sonnet-5", "max", true},
		{"claude-opus-5", "max", false}, {"claude-haiku-5-5", "xhigh", false},
		{"claude-sonnet-5-5", "xhigh", false}, {"claude-opus-4-5", "max", false},
	} {
		t.Run(tc.id, func(t *testing.T) {
			err := ValidateReasoning(Capabilities("standard", "anthropic", tc.id), Reasoning{Enabled: boolptr(false), Effort: tc.effort}, 4096)
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v err=%v", tc.valid, err)
			}
		})
	}
}

func TestOlderOpusOutputCeilingRejectsTooLargeRequests(t *testing.T) {
	for _, id := range []string{"claude-opus-4-20250514", "claude-opus-4-1-20250805"} {
		if err := ValidateReasoning(Capabilities("standard", "anthropic", id), Reasoning{}, 40000); err == nil {
			t.Fatalf("accepted oversized output for %s", id)
		}
	}
}

func TestVerifiedCurrentModelsAcceptTheirDocumentedOutputCeiling(t *testing.T) {
	for _, tc := range []struct{ protocol, id string }{{"anthropic", "claude-sonnet-5-5"}, {"anthropic", "claude-opus-5-5"}, {"anthropic", "claude-haiku-5-5"}, {"anthropic", "claude-fable-5-1"}, {"openai-responses", "gpt-6.1-sol"}} {
		c := Capabilities("standard", tc.protocol, tc.id)
		if err := ValidateReasoning(c, Reasoning{}, 128000); err != nil {
			t.Errorf("rejected documented output ceiling for %s: %v", tc.id, err)
		}
		if err := ValidateReasoning(c, Reasoning{}, 128001); err == nil {
			t.Errorf("accepted above-ceiling output for %s", tc.id)
		}
	}
	if err := ValidateReasoning(Capabilities("standard", "anthropic", "claude-opus-4-5"), Reasoning{Enabled: boolptr(true), BudgetTokens: intptr(60000)}, 64000); err != nil {
		t.Errorf("rejected valid manual thinking budget: %v", err)
	}
}

func TestCapabilityJSONPublishesRulesUsedByValidation(t *testing.T) {
	keys := []string{"budgetWithinOutput", "dynamicBudget", "zeroBudgetDisables", "effortBudgetCompatible", "effortWhileDisabled", "manualBudget", "disabledEffortLimited"}
	for _, tc := range []struct {
		adapter, protocol, id string
		trueRules             map[string]bool
		r                     Reasoning
		max                   int
		valid                 bool
	}{
		{"standard", "anthropic", "claude-opus-4-5", map[string]bool{"budgetWithinOutput": true, "effortBudgetCompatible": true, "effortWhileDisabled": true, "manualBudget": true}, Reasoning{Effort: "high", BudgetTokens: intptr(1024)}, 4096, true},
		{"standard", "gemini", "gemini-2.5-flash", map[string]bool{"budgetWithinOutput": true, "dynamicBudget": true, "zeroBudgetDisables": true}, Reasoning{BudgetTokens: intptr(-1)}, 4096, true},
		{"standard", "gemini", "gemini-2.5-pro", map[string]bool{"budgetWithinOutput": true, "dynamicBudget": true}, Reasoning{BudgetTokens: intptr(4096)}, 4096, false},
		{"siliconflow", "openai-chat", "Qwen/Qwen3-235B-A22B", map[string]bool{}, Reasoning{BudgetTokens: intptr(8192)}, 4096, true},
		{"standard", "anthropic", "claude-sonnet-5-5", map[string]bool{"budgetWithinOutput": true, "effortWhileDisabled": true, "disabledEffortLimited": true}, Reasoning{Enabled: boolptr(false), Effort: "max"}, 4096, false},
		{"standard", "openai-chat", "custom", map[string]bool{}, Reasoning{}, 4096, true},
	} {
		t.Run(tc.id, func(t *testing.T) {
			data, err := json.Marshal(Capabilities(tc.adapter, tc.protocol, tc.id))
			if err != nil {
				t.Fatal(err)
			}
			var fields map[string]any
			if err = json.Unmarshal(data, &fields); err != nil {
				t.Fatal(err)
			}
			for _, key := range keys {
				got, ok := fields[key].(bool)
				if !ok || got != tc.trueRules[key] {
					t.Errorf("JSON rule %s: got %v want %v", key, fields[key], tc.trueRules[key])
				}
			}
			var restored Capability
			if err = json.Unmarshal(data, &restored); err != nil {
				t.Fatal(err)
			}
			if err = ValidateReasoning(restored, tc.r, tc.max); (err == nil) != tc.valid {
				t.Errorf("JSON rules changed validation: valid=%v err=%v", tc.valid, err)
			}
		})
	}
}
