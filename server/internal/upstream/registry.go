// SPDX-License-Identifier: AGPL-3.0-only
package upstream

import (
	"errors"
	"slices"
)

const (
	openAISource   = "https://developers.openai.com/api/docs/guides/reasoning"
	claudeSource   = "https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting"
	geminiSource   = "https://ai.google.dev/gemini-api/docs/generate-content/thinking"
	deepseekSource = "https://api-docs.deepseek.com/guides/thinking_mode/"
	qwenSource     = "https://www.alibabacloud.com/help/en/model-studio/deep-thinking"
	kimiSource     = "https://platform.kimi.ai/docs/api/models-overview"
	glmSource      = "https://docs.bigmodel.cn/cn/guide/capabilities/thinking"
	routerSource   = "https://openrouter.ai/docs/guides/best-practices/reasoning-tokens"
	siliconSource  = "https://docs.siliconflow.cn/docs/api/chat-completions-post"
)

// Registry entries are explicit IDs and documented aliases, never name patterns.
// OutputMax is a conservative supported limit, not an advertised context window.
type profile struct {
	capability Capability
	mode       string
	offType    string
}
type registryKey struct{ adapter, protocol, model string }

var registry = buildRegistry()

func buildRegistry() map[registryKey]profile {
	r := map[registryKey]profile{}
	add := func(adapter, protocol, family, source, mode string, ids []string, efforts []string, toggle, mandatory bool, min, max, output int) {
		for _, id := range ids {
			r[registryKey{adapter, protocol, id}] = profile{Capability{Family: family, Efforts: append([]string{}, efforts...), SupportsToggle: toggle, Mandatory: mandatory, BudgetMin: min, BudgetMax: max, BudgetSupported: max > 0, OutputMax: output, Sources: []string{source}, Known: true, BudgetWithinOutput: family == "claude" || family == "gemini" || adapter == "openrouter", EffortBudgetCompatible: protocol == "anthropic" && mode == "manual" && len(efforts) > 0, DynamicBudget: protocol == "gemini" && mode == "budget", ZeroBudgetDisables: protocol == "gemini" && toggle, ManualBudget: protocol == "anthropic" && mode == "manual", EffortWhileDisabled: protocol == "anthropic"}, mode, "disabled"}
		}
	}
	for _, protocol := range []string{"openai-chat", "openai-responses"} {
		add("standard", protocol, "openai", openAISource, "effort", []string{"o3", "o3-2025-04-16", "o4-mini", "o4-mini-2025-04-16", "o1", "o1-2024-12-17"}, []string{"low", "medium", "high"}, false, true, 0, 0, 100000)
		add("standard", protocol, "openai", openAISource, "effort", []string{"gpt-5", "gpt-5-2025-08-07", "gpt-5-mini", "gpt-5-mini-2025-08-07", "gpt-5-nano", "gpt-5-nano-2025-08-07"}, []string{"minimal", "low", "medium", "high"}, false, true, 0, 0, 128000)
		add("standard", protocol, "openai", openAISource, "effort", []string{"gpt-5.1", "gpt-5.1-2025-11-13"}, []string{"none", "low", "medium", "high"}, true, false, 0, 0, 128000)
		add("standard", protocol, "openai", openAISource, "effort", []string{"gpt-5.2", "gpt-5.2-2025-12-11"}, []string{"none", "low", "medium", "high", "xhigh"}, true, false, 0, 0, 128000)
		add("standard", protocol, "openai", openAISource, "effort", []string{"gpt-6.1-sol"}, []string{"low", "medium", "high", "xhigh", "max"}, false, true, 0, 0, 32768)
	}
	add("standard", "anthropic", "claude", claudeSource, "manual", []string{"claude-3-7-sonnet-20250219", "claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-opus-4-1-20250805", "claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-haiku-4-5", "claude-haiku-4-5-20251001"}, nil, true, false, 1024, 32768, 64000)
	add("standard", "anthropic", "claude", claudeSource, "manual", []string{"claude-opus-4-20250514", "claude-opus-4-1-20250805"}, nil, true, false, 1024, 31999, 32000)
	add("standard", "anthropic", "claude", claudeSource, "manual", []string{"claude-opus-4-5", "claude-opus-4-5-20251101"}, []string{"low", "medium", "high"}, true, false, 1024, 32768, 64000)
	add("standard", "anthropic", "claude", claudeSource, "adaptive", []string{"claude-sonnet-4-6", "claude-opus-4-6"}, []string{"low", "medium", "high", "max"}, true, false, 0, 0, 64000)
	add("standard", "anthropic", "claude", claudeSource, "adaptive", []string{"claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-5"}, []string{"low", "medium", "high", "xhigh", "max"}, true, false, 0, 0, 64000)
	add("standard", "anthropic", "claude", claudeSource, "adaptive", []string{"claude-opus-5-5", "claude-fable-5", "claude-fable-5-1", "claude-mythos-5", "claude-mythos-5-1"}, []string{"low", "medium", "high", "xhigh", "max"}, false, true, 0, 0, 64000)
	// The on/off control for Sonnet 5.5 means up-front thinking. It uses
	// between_tools rather than disabled. Text-only requests have no tools.
	add("standard", "anthropic", "claude", claudeSource, "adaptive", []string{"claude-sonnet-5-5", "claude-opus-5", "claude-haiku-5-5"}, []string{"low", "medium", "high", "xhigh", "max"}, true, false, 0, 0, 64000)
	for _, id := range []string{"claude-sonnet-5-5"} {
		k := registryKey{"standard", "anthropic", id}
		p := r[k]
		p.offType = "between_tools"
		r[k] = p
	}
	for _, id := range []string{"claude-sonnet-5-5", "claude-opus-5", "claude-haiku-5-5"} {
		k := registryKey{"standard", "anthropic", id}
		p := r[k]
		p.capability.DisabledEffortLimited = true
		r[k] = p
	}
	add("standard", "gemini", "gemini", geminiSource, "budget", []string{"gemini-2.5-pro"}, nil, false, true, 128, 32768, 65536)
	add("standard", "gemini", "gemini", geminiSource, "budget", []string{"gemini-2.5-flash"}, nil, true, false, 0, 24576, 65536)
	add("standard", "gemini", "gemini", geminiSource, "budget", []string{"gemini-2.5-flash-lite"}, nil, true, false, 512, 24576, 65536)
	add("standard", "gemini", "gemini", geminiSource, "level", []string{"gemini-3-pro-preview"}, []string{"low", "high"}, false, true, 0, 0, 65536)
	add("standard", "gemini", "gemini", geminiSource, "level", []string{"gemini-3-flash-preview"}, []string{"minimal", "low", "medium", "high"}, false, true, 0, 0, 65536)
	add("standard", "gemini", "gemini", geminiSource, "level", []string{"gemini-3.1-pro-preview"}, []string{"low", "medium", "high"}, false, true, 0, 0, 65536)
	add("deepseek", "openai-chat", "deepseek", deepseekSource, "toggle", []string{"deepseek-chat"}, nil, true, false, 0, 0, 8192)
	add("deepseek", "openai-chat", "deepseek", deepseekSource, "mandatory", []string{"deepseek-reasoner"}, nil, false, true, 0, 0, 32768)
	add("deepseek", "openai-chat", "deepseek", deepseekSource, "toggle", []string{"deepseek-flash", "deepseek-pro"}, []string{"low", "high", "max"}, true, false, 0, 0, 32768)
	add("qwen", "openai-chat", "qwen", qwenSource, "enable", []string{"qwen-plus", "qwen-plus-latest", "qwen-plus-2025-04-28", "qwen-flash", "qwen-flash-2025-07-28", "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-max-2026-05-20", "qwen3.7-max-2026-06-08", "qwen3.6-plus", "qwen3.5-plus"}, nil, true, false, 1, 32768, 32768)
	add("kimi", "openai-chat", "kimi", kimiSource, "toggle", []string{"kimi-k2.5", "kimi-k2.6"}, nil, true, false, 0, 0, 32768)
	add("kimi", "openai-chat", "kimi", kimiSource, "mandatory", []string{"kimi-k2-thinking", "kimi-k2-thinking-turbo", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"}, nil, false, true, 0, 0, 32768)
	add("kimi", "openai-chat", "kimi", kimiSource, "effort", []string{"kimi-k3"}, []string{"low", "high", "max"}, false, true, 0, 0, 32768)
	add("glm", "openai-chat", "glm", glmSource, "toggle", []string{"glm-4.5", "glm-4.5-air", "glm-4.6", "glm-4.7", "glm-5", "glm-5.1"}, nil, true, false, 0, 0, 32768)
	add("glm", "openai-chat", "glm", glmSource, "toggle", []string{"glm-5.2"}, []string{"high", "max"}, true, false, 0, 0, 32768)
	add("glm", "openai-chat", "glm", glmSource, "toggle", []string{"glm-5.3", "glm-5.3-flash", "glm-5.3-flashx"}, []string{"low", "high", "max"}, false, true, 0, 0, 32768)
	// OpenRouter's normalized reasoning object overrides native vendor fields.
	for _, v := range []struct {
		id, family        string
		efforts           []string
		toggle, mandatory bool
		budget            int
	}{
		{"openai/o3", "openai", []string{"low", "medium", "high"}, false, true, 0},
		{"openai/gpt-5", "openai", []string{"minimal", "low", "medium", "high"}, false, true, 0},
		{"anthropic/claude-sonnet-4.5", "claude", []string{"low", "medium", "high"}, true, false, 32768},
		{"anthropic/claude-sonnet-4.6", "claude", []string{"low", "medium", "high"}, true, false, 0},
		{"google/gemini-2.5-pro", "gemini", nil, false, true, 32768},
		{"deepseek/deepseek-r1", "deepseek", nil, false, true, 0},
		{"qwen/qwen3-235b-a22b", "qwen", nil, true, false, 32768},
		{"moonshotai/kimi-k2.5", "kimi", nil, true, false, 0},
		{"z-ai/glm-4.6", "glm", nil, true, false, 0},
	} {
		min := 0
		if v.budget > 0 {
			min = 1024
		}
		add("openrouter", "openai-chat", v.family, routerSource, "router", []string{v.id}, v.efforts, v.toggle, v.mandatory, min, v.budget, 32768)
	}
	add("siliconflow", "openai-chat", "qwen", siliconSource, "enable", []string{"Qwen/Qwen3-235B-A22B", "Qwen/Qwen3-32B", "Qwen/Qwen3-8B"}, nil, true, false, 128, 32768, 32768)
	add("siliconflow", "openai-chat", "deepseek", siliconSource, "mandatory", []string{"deepseek-ai/DeepSeek-R1"}, nil, false, true, 0, 0, 32768)
	add("siliconflow", "openai-chat", "deepseek", siliconSource, "enable", []string{"Pro/deepseek-ai/DeepSeek-V4", "deepseek-ai/DeepSeek-V4-Flash"}, []string{"high", "max"}, true, false, 128, 32768, 32768)
	add("siliconflow", "openai-chat", "glm", siliconSource, "enable", []string{"Pro/zai-org/GLM-5.2"}, []string{"high", "max"}, true, false, 128, 32768, 32768)
	// GLM-5.3 Flash is only listed under its exact SiliconFlow namespace. The
	// thinking parameters come from the Zhipu model page, so both sources are
	// recorded; thinking cannot be turned off on this model.
	add("siliconflow", "openai-chat", "glm", siliconSource, "enable", []string{"zai-org/GLM-5.3-Flash"}, []string{"low", "high", "max"}, false, true, 128, 32768, 128000)
	for _, id := range []string{"zai-org/GLM-5.3-Flash"} {
		k := registryKey{"siliconflow", "openai-chat", id}
		p := r[k]
		p.capability.Sources = append(p.capability.Sources, "https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash")
		r[k] = p
	}
	for _, id := range []string{"claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-1"} {
		k := registryKey{"standard", "anthropic", id}
		p := r[k]
		p.capability.OutputMax = 128000
		p.capability.Sources = append(p.capability.Sources, "https://platform.claude.com/docs/en/models/opus-4-5/overview")
		r[k] = p
	}
	for _, protocol := range []string{"openai-chat", "openai-responses"} {
		k := registryKey{"standard", protocol, "gpt-6.1-sol"}
		p := r[k]
		p.capability.OutputMax = 128000
		p.capability.Sources = append(p.capability.Sources, "https://developers.openai.com/api/docs/models/gpt-6.1-sol")
		r[k] = p
	}
	for k, p := range r {
		if p.mode == "manual" {
			p.capability.BudgetMax = p.capability.OutputMax - 1
			p.capability.Sources = append(p.capability.Sources, "https://platform.claude.com/docs/en/build-with-claude/extended-thinking")
			r[k] = p
		}
		if p.capability.Family == "claude" && len(p.capability.Efforts) > 0 {
			p = r[k]
			p.capability.Sources = append(p.capability.Sources, "https://platform.claude.com/docs/en/build-with-claude/effort")
			r[k] = p
		}
	}
	return r
}

func getProfile(adapter, protocol, id string) profile {
	if adapter == "" {
		adapter = "standard"
	}
	if p, ok := registry[registryKey{adapter, protocol, id}]; ok {
		return p
	}
	return profile{capability: Capability{Efforts: []string{}, Sources: []string{}, OutputMax: 4096}}
}
func Capabilities(adapter, protocol, modelID string) Capability {
	c := getProfile(adapter, protocol, modelID).capability
	c.Efforts = slices.Clone(c.Efforts)
	c.Sources = slices.Clone(c.Sources)
	return c
}

func ValidateReasoning(c Capability, r Reasoning, maxOutput int) error {
	if maxOutput <= 0 || maxOutput > c.OutputMax {
		return errors.New("输出上限超出模型支持范围")
	}
	if !c.Known && (r.Enabled != nil || r.Effort != "" || r.BudgetTokens != nil) {
		return errors.New("未知模型不支持已配置的思考参数")
	}
	if r.Enabled != nil {
		if !*r.Enabled && (!c.SupportsToggle || c.Mandatory) {
			return errors.New("该模型不能关闭思考")
		}
		if *r.Enabled && !c.SupportsToggle && !c.Mandatory {
			return errors.New("该模型不支持思考开关")
		}
		if !*r.Enabled && (r.BudgetTokens != nil || !c.EffortWhileDisabled && r.Effort != "" && r.Effort != "none") {
			return errors.New("关闭思考时不能设置预算或思考档位")
		}
		if *r.Enabled && r.Effort == "none" {
			return errors.New("思考开关与档位冲突")
		}
	}
	if r.Effort != "" && !slices.Contains(c.Efforts, r.Effort) {
		return errors.New("模型不支持该思考档位")
	}
	if r.BudgetTokens != nil {
		b := *r.BudgetTokens
		if !c.BudgetSupported || (b < c.BudgetMin || b > c.BudgetMax) && !(b == -1 && c.DynamicBudget) && !(b == 0 && c.ZeroBudgetDisables) {
			return errors.New("思考预算超出模型支持范围")
		}
		if c.BudgetWithinOutput && b >= maxOutput {
			return errors.New("思考预算必须小于输出上限")
		}
		if r.Effort != "" && !c.EffortBudgetCompatible {
			return errors.New("思考档位与预算不能同时设置")
		}
		if r.Enabled != nil && *r.Enabled && b == 0 && c.ZeroBudgetDisables {
			return errors.New("启用思考时预算不能为零")
		}
	}
	if c.ManualBudget && r.Enabled != nil && *r.Enabled && r.BudgetTokens == nil && maxOutput <= 1024 {
		return errors.New("思考预算必须小于输出上限")
	}
	if c.DisabledEffortLimited && r.Enabled != nil && !*r.Enabled && (r.Effort == "xhigh" || r.Effort == "max") {
		return errors.New("该档位不能关闭思考")
	}
	return nil
}

func Templates() []Template {
	return []Template{
		{"openai", "OpenAI", "openai-chat", "standard", "https://api.openai.com/v1"},
		{"openai-responses", "OpenAI Responses", "openai-responses", "standard", "https://api.openai.com/v1"},
		{"gemini", "Gemini", "gemini", "standard", "https://generativelanguage.googleapis.com/v1beta"},
		{"anthropic", "Anthropic", "anthropic", "standard", "https://api.anthropic.com/v1"},
		{"openrouter", "OpenRouter", "openai-chat", "openrouter", "https://openrouter.ai/api/v1"},
		{"siliconflow", "硅基流动", "openai-chat", "siliconflow", "https://api.siliconflow.cn/v1"},
		{"new-api", "New API", "openai-chat", "standard", ""},
		{"one-api", "One API", "openai-chat", "standard", ""},
		{"custom", "自定义", "openai-chat", "standard", ""},
	}
}
