// SPDX-License-Identifier: AGPL-3.0-only
package upstream

import "slices"

// CatalogVersion identifies the built-in model catalog snapshot shipped with
// this build. The HTTP discovery endpoints report it so clients can drop cached
// candidate lists after a server upgrade. The catalog is compiled into the
// binary and never downloaded at runtime.
func CatalogVersion() string { return "2026-10-11.1" }

// catalogVerifiedDate is the date the entries below were last checked against
// the sources recorded in the capability registry. It is per-entry data, not a
// claim that a live call to any account succeeded.
const catalogVerifiedDate = "2026-10-11"

// glm53FlashSiliconNotes is mandatory wording for the SiliconFlow GLM-5.3 Flash
// alias: listing a candidate never proves the account may use it.
const glm53FlashSiliconNotes = "硅基流动是否上架该型号未经真实调用核实，目录候选不代表账号已获权限，以账号自身 /models 返回为准。"

// RecommendedDefaults are the safe values pre-filled when a known model is
// added. DefaultReasoning stays empty so the supplier default applies; it never
// means "turn on the strongest effort".
type RecommendedDefaults struct {
	MaxOutputTokens  int       `json:"maxOutputTokens"`
	DefaultReasoning Reasoning `json:"defaultReasoning"`
}

// CatalogEntry is one enumerable built-in candidate. Capabilities always come
// from the registry so the catalog can never contradict the protocol logic.
type CatalogEntry struct {
	ID                  string              `json:"id"`
	Adapter             string              `json:"adapter"`
	Protocol            string              `json:"protocol"`
	Name                string              `json:"name"`
	Capabilities        Capability          `json:"capabilities"`
	RecommendedDefaults RecommendedDefaults `json:"recommendedDefaults"`
	VerifiedDate        string              `json:"verifiedDate"`
	Notes               string              `json:"notes,omitempty"`
}

type catalogSeed struct {
	adapter   string
	protocols []string
	id        string
	name      string
	notes     string
}

// catalogSeeds are display metadata only: every ID must exist in the registry,
// and the catalog carries no capability table of its own.
var catalogSeeds = []catalogSeed{
	{adapter: "standard", protocols: []string{"openai-chat", "openai-responses"}, id: "o3", name: "o3"},
	{adapter: "standard", protocols: []string{"openai-chat", "openai-responses"}, id: "o4-mini", name: "o4-mini"},
	{adapter: "standard", protocols: []string{"openai-chat", "openai-responses"}, id: "gpt-5", name: "GPT-5"},
	{adapter: "standard", protocols: []string{"openai-chat", "openai-responses"}, id: "gpt-5.1", name: "GPT-5.1"},
	{adapter: "standard", protocols: []string{"openai-chat", "openai-responses"}, id: "gpt-5.2", name: "GPT-5.2"},
	{adapter: "standard", protocols: []string{"openai-chat", "openai-responses"}, id: "gpt-6.1-sol", name: "GPT-6.1 Sol"},
	{adapter: "standard", protocols: []string{"anthropic"}, id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5"},
	{adapter: "standard", protocols: []string{"anthropic"}, id: "claude-opus-4-5", name: "Claude Opus 4.5"},
	{adapter: "standard", protocols: []string{"anthropic"}, id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5"},
	{adapter: "standard", protocols: []string{"anthropic"}, id: "claude-opus-5-5", name: "Claude Opus 5.5"},
	{adapter: "standard", protocols: []string{"anthropic"}, id: "claude-haiku-5-5", name: "Claude Haiku 5.5"},
	{adapter: "standard", protocols: []string{"gemini"}, id: "gemini-2.5-pro", name: "Gemini 2.5 Pro"},
	{adapter: "standard", protocols: []string{"gemini"}, id: "gemini-2.5-flash", name: "Gemini 2.5 Flash"},
	{adapter: "standard", protocols: []string{"gemini"}, id: "gemini-3-pro-preview", name: "Gemini 3 Pro Preview"},
	{adapter: "standard", protocols: []string{"gemini"}, id: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview"},
	{adapter: "deepseek", protocols: []string{"openai-chat"}, id: "deepseek-chat", name: "DeepSeek Chat"},
	{adapter: "deepseek", protocols: []string{"openai-chat"}, id: "deepseek-reasoner", name: "DeepSeek Reasoner", notes: "该型号始终思考，不能关闭。"},
	{adapter: "deepseek", protocols: []string{"openai-chat"}, id: "deepseek-flash", name: "DeepSeek Flash"},
	{adapter: "qwen", protocols: []string{"openai-chat"}, id: "qwen-plus", name: "Qwen Plus"},
	{adapter: "qwen", protocols: []string{"openai-chat"}, id: "qwen-flash", name: "Qwen Flash"},
	{adapter: "qwen", protocols: []string{"openai-chat"}, id: "qwen3.7-max", name: "Qwen3.7 Max"},
	{adapter: "kimi", protocols: []string{"openai-chat"}, id: "kimi-k2.5", name: "Kimi K2.5"},
	{adapter: "kimi", protocols: []string{"openai-chat"}, id: "kimi-k2-thinking", name: "Kimi K2 Thinking", notes: "该型号始终思考，不能关闭。"},
	{adapter: "kimi", protocols: []string{"openai-chat"}, id: "kimi-k3", name: "Kimi K3"},
	{adapter: "glm", protocols: []string{"openai-chat"}, id: "glm-4.6", name: "GLM-4.6"},
	{adapter: "glm", protocols: []string{"openai-chat"}, id: "glm-5", name: "GLM-5"},
	{adapter: "glm", protocols: []string{"openai-chat"}, id: "glm-5.1", name: "GLM-5.1"},
	{adapter: "glm", protocols: []string{"openai-chat"}, id: "glm-5.2", name: "GLM-5.2"},
	{adapter: "glm", protocols: []string{"openai-chat"}, id: "glm-5.3", name: "GLM-5.3", notes: "该型号始终思考，不能关闭。"},
	{adapter: "glm", protocols: []string{"openai-chat"}, id: "glm-5.3-flash", name: "GLM-5.3 Flash", notes: "该型号始终思考，不能关闭。"},
	{adapter: "siliconflow", protocols: []string{"openai-chat"}, id: "Qwen/Qwen3-235B-A22B", name: "Qwen3 235B A22B"},
	{adapter: "siliconflow", protocols: []string{"openai-chat"}, id: "Qwen/Qwen3-32B", name: "Qwen3 32B"},
	{adapter: "siliconflow", protocols: []string{"openai-chat"}, id: "deepseek-ai/DeepSeek-R1", name: "DeepSeek R1", notes: "该型号始终思考，不能关闭。"},
	{adapter: "siliconflow", protocols: []string{"openai-chat"}, id: "Pro/deepseek-ai/DeepSeek-V4", name: "DeepSeek V4"},
	{adapter: "siliconflow", protocols: []string{"openai-chat"}, id: "Pro/zai-org/GLM-5.2", name: "GLM-5.2（硅基流动）", notes: "硅基流动托管的 GLM-5.2；能否调用以账号自身 /models 返回为准。"},
	{adapter: "siliconflow", protocols: []string{"openai-chat"}, id: "zai-org/GLM-5.3-Flash", name: "GLM-5.3 Flash（硅基流动）", notes: glm53FlashSiliconNotes + "参数来源：https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash 与 https://docs.siliconflow.cn/docs/api/chat-completions-post。"},
	{adapter: "openrouter", protocols: []string{"openai-chat"}, id: "openai/o3", name: "o3（OpenRouter）"},
	{adapter: "openrouter", protocols: []string{"openai-chat"}, id: "openai/gpt-5", name: "GPT-5（OpenRouter）"},
	{adapter: "openrouter", protocols: []string{"openai-chat"}, id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5（OpenRouter）"},
	{adapter: "openrouter", protocols: []string{"openai-chat"}, id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6（OpenRouter）"},
	{adapter: "openrouter", protocols: []string{"openai-chat"}, id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro（OpenRouter）"},
	{adapter: "openrouter", protocols: []string{"openai-chat"}, id: "deepseek/deepseek-r1", name: "DeepSeek R1（OpenRouter）"},
	{adapter: "openrouter", protocols: []string{"openai-chat"}, id: "qwen/qwen3-235b-a22b", name: "Qwen3 235B A22B（OpenRouter）"},
	{adapter: "openrouter", protocols: []string{"openai-chat"}, id: "moonshotai/kimi-k2.5", name: "Kimi K2.5（OpenRouter）"},
	{adapter: "openrouter", protocols: []string{"openai-chat"}, id: "z-ai/glm-4.6", name: "GLM-4.6（OpenRouter）"},
}

type catalogKey struct{ adapter, protocol, id string }

var (
	catalogEntries = buildCatalog()
	catalogIndex   = indexCatalog(catalogEntries)
)

func buildCatalog() []CatalogEntry {
	entries := make([]CatalogEntry, 0, len(catalogSeeds))
	for _, seed := range catalogSeeds {
		for _, protocol := range seed.protocols {
			capability := Capabilities(seed.adapter, protocol, seed.id)
			entries = append(entries, CatalogEntry{
				ID:                  seed.id,
				Adapter:             seed.adapter,
				Protocol:            protocol,
				Name:                seed.name,
				Capabilities:        capability,
				RecommendedDefaults: RecommendedDefaults{MaxOutputTokens: capability.RecommendedOutputTokens(), DefaultReasoning: Reasoning{}},
				VerifiedDate:        catalogVerifiedDate,
				Notes:               seed.notes,
			})
		}
	}
	return entries
}

func indexCatalog(entries []CatalogEntry) map[catalogKey]int {
	index := make(map[catalogKey]int, len(entries))
	for i, entry := range entries {
		index[catalogKey{entry.Adapter, entry.Protocol, entry.ID}] = i
	}
	return index
}

func normalizeAdapter(adapter string) string {
	if adapter == "" {
		return "standard"
	}
	return adapter
}

// RecommendedOutputTokens is the conservative default output limit for a
// capability: never above 4096 and never above the verified model limit.
func (c Capability) RecommendedOutputTokens() int {
	limit := 4096
	if c.OutputMax > 0 && c.OutputMax < limit {
		limit = c.OutputMax
	}
	return limit
}

func cloneCapability(c Capability) Capability {
	c.Efforts = slices.Clone(c.Efforts)
	c.Sources = slices.Clone(c.Sources)
	return c
}

func cloneEntry(e CatalogEntry) CatalogEntry {
	e.Capabilities = cloneCapability(e.Capabilities)
	return e
}

// Catalog returns every built-in entry in a stable order. Callers receive
// copies so the compiled snapshot cannot be mutated through the result.
func Catalog() []CatalogEntry {
	entries := make([]CatalogEntry, 0, len(catalogEntries))
	for _, entry := range catalogEntries {
		entries = append(entries, cloneEntry(entry))
	}
	return entries
}

// CatalogFor returns the built-in candidates compatible with one provider
// adapter and protocol. An empty result means manual entry is the only option.
func CatalogFor(adapter, protocol string) []CatalogEntry {
	entries := []CatalogEntry{}
	for _, entry := range catalogEntries {
		if entry.Adapter == normalizeAdapter(adapter) && entry.Protocol == protocol {
			entries = append(entries, cloneEntry(entry))
		}
	}
	return entries
}

// ResolveCapabilities reports the registered capability of an exact catalog
// identity. Lookups are exact: no case folding, prefix stripping or namespace
// guessing, so a look-alike ID stays unknown.
func ResolveCapabilities(adapter, protocol, modelID string) (Capability, bool) {
	i, ok := catalogIndex[catalogKey{normalizeAdapter(adapter), protocol, modelID}]
	if !ok {
		return Capability{}, false
	}
	return cloneCapability(catalogEntries[i].Capabilities), true
}

// CatalogEntryFor reports the built-in entry of an exact catalog identity.
func CatalogEntryFor(adapter, protocol, modelID string) (CatalogEntry, bool) {
	i, ok := catalogIndex[catalogKey{normalizeAdapter(adapter), protocol, modelID}]
	if !ok {
		return CatalogEntry{}, false
	}
	return cloneEntry(catalogEntries[i]), true
}

// CatalogName reports the display name of an exact catalog identity.
func CatalogName(adapter, protocol, modelID string) (string, bool) {
	entry, ok := CatalogEntryFor(adapter, protocol, modelID)
	if !ok {
		return "", false
	}
	return entry.Name, true
}
