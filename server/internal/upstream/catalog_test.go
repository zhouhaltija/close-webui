// SPDX-License-Identifier: AGPL-3.0-only
package upstream

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestCatalogIsEnumerableAndCoversSevenFamilies(t *testing.T) {
	entries := Catalog()
	if len(entries) == 0 {
		t.Fatal("catalog is empty")
	}
	families := map[string]bool{}
	for _, entry := range entries {
		if entry.ID == "" || entry.Name == "" {
			t.Fatalf("entry missing identity: %+v", entry)
		}
		if entry.VerifiedDate == "" {
			t.Fatalf("entry missing verified date: %+v", entry)
		}
		if entry.Capabilities.OutputMax <= 0 || !entry.Capabilities.Known {
			t.Fatalf("entry without verified registry capability: %+v", entry)
		}
		families[entry.Capabilities.Family] = true
	}
	for _, family := range []string{"openai", "claude", "gemini", "deepseek", "qwen", "kimi", "glm"} {
		if !families[family] {
			t.Fatalf("catalog has no %s entry: %v", family, families)
		}
	}
}

func TestCatalogCapabilitiesNeverContradictRegistry(t *testing.T) {
	for _, entry := range Catalog() {
		want := Capabilities(entry.Adapter, entry.Protocol, entry.ID)
		if !reflect.DeepEqual(entry.Capabilities, want) {
			t.Fatalf("%s/%s/%s catalog capability differs from registry:\n%+v\n%+v", entry.Adapter, entry.Protocol, entry.ID, entry.Capabilities, want)
		}
		if resolved, ok := ResolveCapabilities(entry.Adapter, entry.Protocol, entry.ID); !ok || !reflect.DeepEqual(resolved, want) {
			t.Fatalf("%s/%s/%s not resolvable to registry capability", entry.Adapter, entry.Protocol, entry.ID)
		}
	}
}

func TestCatalogVersionAndVerifiedDatesAreTraceable(t *testing.T) {
	version := CatalogVersion()
	if version == "" {
		t.Fatal("catalog version is empty")
	}
	if _, err := time.Parse("2006-01-02.1", version); err != nil {
		t.Fatalf("catalog version %q is not a dated snapshot", version)
	}
	for _, entry := range Catalog() {
		if _, err := time.Parse("2006-01-02", entry.VerifiedDate); err != nil {
			t.Fatalf("entry %s verified date %q invalid", entry.ID, entry.VerifiedDate)
		}
	}
}

func TestCatalogRecommendedDefaultsAreSafe(t *testing.T) {
	for _, entry := range Catalog() {
		want := entry.Capabilities.OutputMax
		if want > 4096 {
			want = 4096
		}
		if entry.RecommendedDefaults.MaxOutputTokens != want {
			t.Fatalf("%s default output = %d, want min(4096,%d)", entry.ID, entry.RecommendedDefaults.MaxOutputTokens, entry.Capabilities.OutputMax)
		}
		if !reflect.DeepEqual(entry.RecommendedDefaults.DefaultReasoning, Reasoning{}) {
			t.Fatalf("%s default reasoning is not the supplier default: %+v", entry.ID, entry.RecommendedDefaults.DefaultReasoning)
		}
		if entry.RecommendedDefaults.MaxOutputTokens <= 0 || entry.RecommendedDefaults.MaxOutputTokens > 262144 {
			t.Fatalf("%s default output out of the savable range", entry.ID)
		}
	}
}

func TestCatalogForFiltersByAdapterAndProtocol(t *testing.T) {
	glm := CatalogFor("glm", "openai-chat")
	if len(glm) == 0 {
		t.Fatal("no glm candidates")
	}
	for _, entry := range glm {
		if entry.Adapter != "glm" || entry.Protocol != "openai-chat" {
			t.Fatalf("unexpected candidate: %+v", entry)
		}
	}
	if len(CatalogFor("deepseek", "openai-responses")) != 0 {
		t.Fatal("incompatible protocol returned candidates")
	}
	// An empty adapter behaves like the standard adapter, matching Capabilities().
	if len(CatalogFor("", "anthropic")) != len(CatalogFor("standard", "anthropic")) {
		t.Fatal("empty adapter did not normalize to standard")
	}
	byID := map[string]bool{}
	for _, entry := range glm {
		if byID[entry.ID] {
			t.Fatalf("duplicate candidate %s", entry.ID)
		}
		byID[entry.ID] = true
	}
}

func TestCatalogResolvesOnlyExactIdentities(t *testing.T) {
	if _, ok := ResolveCapabilities("siliconflow", "openai-chat", "zai-org/GLM-5.3-Flash"); !ok {
		t.Fatal("exact siliconflow GLM-5.3 Flash alias not resolved")
	}
	for _, tc := range []struct{ adapter, protocol, id string }{
		{"siliconflow", "openai-chat", "zai-org/glm-5.3-flash"},
		{"siliconflow", "openai-chat", "GLM-5.3-Flash"},
		{"siliconflow", "openai-chat", "Pro/zai-org/GLM-5.3-Flash"},
		{"glm", "openai-chat", "zai-org/GLM-5.3-Flash"},
		{"siliconflow", "openai-responses", "zai-org/GLM-5.3-Flash"},
		{"standard", "openai-chat", "glm-5.3-flash-clone"},
	} {
		if _, ok := ResolveCapabilities(tc.adapter, tc.protocol, tc.id); ok {
			t.Fatalf("inferred capability for %+v", tc)
		}
	}
	// The bare GLM-5.3 Flash identity exists only under the glm adapter.
	if _, ok := ResolveCapabilities("glm", "openai-chat", "glm-5.3-flash"); !ok {
		t.Fatal("glm adapter identity missing")
	}
}

func TestCatalogSiliconflowGLM53FlashEntry(t *testing.T) {
	capability, ok := ResolveCapabilities("siliconflow", "openai-chat", "zai-org/GLM-5.3-Flash")
	if !ok {
		t.Fatal("siliconflow GLM-5.3 Flash alias missing")
	}
	if !capability.Mandatory || capability.SupportsToggle {
		t.Fatalf("mandatory thinking misreported: %+v", capability)
	}
	if !reflect.DeepEqual(capability.Efforts, []string{"low", "high", "max"}) {
		t.Fatalf("efforts = %v", capability.Efforts)
	}
	if capability.OutputMax != 128000 {
		t.Fatalf("output max = %d, want 128000", capability.OutputMax)
	}
	if capability.BudgetMin != 128 || capability.BudgetMax != 32768 || !capability.BudgetSupported {
		t.Fatalf("budget range = %d..%d supported=%v", capability.BudgetMin, capability.BudgetMax, capability.BudgetSupported)
	}
	if capability.Family != "glm" || !capability.Known {
		t.Fatalf("family/known wrong: %+v", capability)
	}
	var entry CatalogEntry
	found := false
	for _, candidate := range CatalogFor("siliconflow", "openai-chat") {
		if candidate.ID == "zai-org/GLM-5.3-Flash" {
			entry, found = candidate, true
		}
	}
	if !found {
		t.Fatal("siliconflow GLM-5.3 Flash not listed for the adapter")
	}
	if entry.VerifiedDate != "2026-10-11" {
		t.Fatalf("verified date = %q", entry.VerifiedDate)
	}
	for _, want := range []string{"未经真实调用核实", "不代表账号已获权限", "/models", "https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash", "https://docs.siliconflow.cn/docs/api/chat-completions-post"} {
		if !strings.Contains(entry.Notes, want) {
			t.Fatalf("notes missing %q: %s", want, entry.Notes)
		}
	}
	// The mandatory model must reject being switched off while keeping the
	// documented efforts and budget range usable.
	if err := ValidateReasoning(capability, Reasoning{Enabled: boolptr(false)}, 4096); err == nil {
		t.Fatal("accepted disabling mandatory thinking")
	}
	if err := ValidateReasoning(capability, Reasoning{Effort: "max"}, 4096); err != nil {
		t.Fatal("rejected documented effort:", err)
	}
	if err := ValidateReasoning(capability, Reasoning{BudgetTokens: intptr(128)}, 4096); err != nil {
		t.Fatal("rejected documented minimum budget:", err)
	}
	for _, budget := range []int{127, 32769} {
		if err := ValidateReasoning(capability, Reasoning{BudgetTokens: intptr(budget)}, 4096); err == nil {
			t.Fatalf("accepted out-of-range budget %d", budget)
		}
	}
}

func TestCatalogDocumentsExistingSiliconflowGLM52(t *testing.T) {
	entry, ok := ResolveCapabilities("siliconflow", "openai-chat", "Pro/zai-org/GLM-5.2")
	if !ok {
		t.Fatal("siliconflow GLM-5.2 alias missing")
	}
	if entry.OutputMax != 32768 || !entry.SupportsToggle {
		t.Fatalf("unexpected GLM-5.2 capability: %+v", entry)
	}
	name, ok := CatalogName("siliconflow", "openai-chat", "Pro/zai-org/GLM-5.2")
	if !ok || name == "" {
		t.Fatal("siliconflow GLM-5.2 has no display name")
	}
	for _, candidate := range CatalogFor("siliconflow", "openai-chat") {
		if candidate.ID == "Pro/zai-org/GLM-5.2" && candidate.Notes == "" {
			t.Fatal("siliconflow GLM-5.2 has no notes")
		}
	}
}

func TestCatalogReturnsCopies(t *testing.T) {
	first := Catalog()
	first[0].Name = "mutated"
	first[0].Capabilities.Efforts[0] = "mutated"
	second := Catalog()
	if second[0].Name == "mutated" || second[0].Capabilities.Efforts[0] == "mutated" {
		t.Fatal("catalog snapshot is mutable through returned entries")
	}
}
