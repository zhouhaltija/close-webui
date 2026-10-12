// SPDX-License-Identifier: AGPL-3.0-only
package upstream

import (
	"encoding/json"
	"slices"
)

// ModelMetadata contains only documented public discovery fields. Missing and
// explicit false values differ: absence must never manufacture a control.
type ModelMetadata struct {
	OutputMax          int            `json:"outputMax,omitempty"`
	ContextWindow      int            `json:"contextWindow,omitempty"`
	ReasoningSupported *bool          `json:"reasoningSupported,omitempty"`
	ThinkingTypes      *ThinkingTypes `json:"thinkingTypes,omitempty"`
	EffortSupported    *bool          `json:"effortSupported,omitempty"`
	Efforts            []string       `json:"efforts,omitempty"`
}

type ThinkingTypes struct {
	Adaptive *bool `json:"adaptive,omitempty"`
	Enabled  *bool `json:"enabled,omitempty"`
	Disabled *bool `json:"disabled,omitempty"`
}

var anthropicEfforts = []string{"low", "medium", "high", "xhigh", "max"}

func positiveLimit(raw json.RawMessage) int {
	var n int
	if json.Unmarshal(raw, &n) != nil || n <= 0 || n > 1_000_000_000 {
		return 0
	}
	return n
}

func explicitBool(raw json.RawMessage) *bool {
	var value bool
	if string(raw) == "null" || len(raw) == 0 || json.Unmarshal(raw, &value) != nil {
		return nil
	}
	return &value
}

func supportField(raw json.RawMessage) *bool {
	var field struct {
		Supported json.RawMessage `json:"supported"`
	}
	if json.Unmarshal(raw, &field) != nil {
		return nil
	}
	return explicitBool(field.Supported)
}

func publicMetadata(p ProviderConfig, raw json.RawMessage) *ModelMetadata {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return nil
	}
	m := &ModelMetadata{}
	if p.Adapter == "" {
		p.Adapter = "standard"
	}
	switch {
	case p.Protocol == "anthropic" && p.Adapter == "standard":
		m.OutputMax, m.ContextWindow = positiveLimit(fields["max_tokens"]), positiveLimit(fields["max_input_tokens"])
		var capabilities map[string]json.RawMessage
		_ = json.Unmarshal(fields["capabilities"], &capabilities)
		m.ReasoningSupported = supportField(capabilities["thinking"])
		var thinking struct {
			Types map[string]json.RawMessage `json:"types"`
		}
		_ = json.Unmarshal(capabilities["thinking"], &thinking)
		if thinking.Types != nil {
			m.ThinkingTypes = &ThinkingTypes{Adaptive: supportField(thinking.Types["adaptive"]), Enabled: supportField(thinking.Types["enabled"]), Disabled: supportField(thinking.Types["disabled"])}
		}
		var effort map[string]json.RawMessage
		_ = json.Unmarshal(capabilities["effort"], &effort)
		m.EffortSupported = explicitBool(effort["supported"])
		for _, level := range anthropicEfforts {
			if supported := supportField(effort[level]); supported != nil && *supported {
				m.Efforts = append(m.Efforts, level)
			}
		}
	case p.Protocol == "gemini" && p.Adapter == "standard":
		m.OutputMax, m.ContextWindow = positiveLimit(fields["outputTokenLimit"]), positiveLimit(fields["inputTokenLimit"])
		m.ReasoningSupported = explicitBool(fields["thinking"])
	case p.Protocol == "openai-chat" && p.Adapter == "openrouter":
		var top map[string]json.RawMessage
		_ = json.Unmarshal(fields["top_provider"], &top)
		m.OutputMax = positiveLimit(top["max_completion_tokens"])
		m.ContextWindow = positiveLimit(top["context_length"])
		if m.ContextWindow == 0 {
			m.ContextWindow = positiveLimit(fields["context_length"])
		}
		var parameters []string
		if string(fields["supported_parameters"]) != "null" && json.Unmarshal(fields["supported_parameters"], &parameters) == nil {
			v := slices.Contains(parameters, "reasoning")
			m.ReasoningSupported = &v
		}
	default:
		return nil
	}
	if m.OutputMax == 0 && m.ContextWindow == 0 && m.ReasoningSupported == nil && m.ThinkingTypes == nil && m.EffortSupported == nil {
		return nil
	}
	return m
}

func isTrue(value *bool) bool  { return value != nil && *value }
func isFalse(value *bool) bool { return value != nil && !*value }

// CapabilitiesWithMetadata is the single rule used by discovery, persisted
// model views, saves, generation snapshots and request serialization.
func CapabilitiesWithMetadata(adapter, protocol, id string, metadata *ModelMetadata) Capability {
	return cloneCapability(profileWithMetadata(adapter, protocol, id, metadata).capability)
}

func clearReasoning(c *Capability) {
	c.Known = false
	c.Efforts = []string{}
	c.SupportsToggle, c.Mandatory, c.BudgetSupported = false, false, false
	c.BudgetMin, c.BudgetMax = 0, 0
}

func profileWithMetadata(adapter, protocol, id string, m *ModelMetadata) profile {
	p := getProfile(adapter, protocol, id)
	p.capability = cloneCapability(p.capability)
	c := &p.capability
	c.OutputSource = "conservative"
	if c.Known {
		c.OutputSource = "catalog"
		value := true
		c.ReasoningSupported = &value
	}
	adapter = normalizeAdapter(adapter)
	// Never apply one vendor's contract through another adapter or protocol.
	if m == nil || !((adapter == "standard" && (protocol == "anthropic" || protocol == "gemini")) || (adapter == "openrouter" && protocol == "openai-chat")) {
		return p
	}
	if m.OutputMax > 0 && m.OutputMax <= 1_000_000_000 {
		if !c.Known || m.OutputMax < c.OutputMax {
			c.OutputMax = m.OutputMax
		}
		c.OutputSource = "upstream"
	}
	if m.ContextWindow > 0 && m.ContextWindow <= 1_000_000_000 {
		c.ContextWindow = m.ContextWindow
	}
	if m.ReasoningSupported != nil {
		value := *m.ReasoningSupported
		c.ReasoningSupported = &value
	}
	if isFalse(m.ReasoningSupported) {
		clearReasoning(c)
		return p
	}
	if protocol != "anthropic" {
		return p
	}
	if !c.Known {
		// Native types are a formal Anthropic contract, not ID-name inference.
		if m.ThinkingTypes != nil && !isFalse(m.ReasoningSupported) {
			if isTrue(m.ThinkingTypes.Adaptive) {
				p.mode = "adaptive"
			} else if isTrue(m.ThinkingTypes.Enabled) {
				p.mode = "manual"
			}
			if p.mode != "" {
				p.offType = "disabled"
				c.Known, c.Family = true, "claude"
				c.SupportsToggle = isTrue(m.ThinkingTypes.Disabled)
				c.Mandatory = isFalse(m.ThinkingTypes.Disabled)
				c.EffortWhileDisabled = true
				c.BudgetWithinOutput = true
				if p.mode == "manual" {
					c.ManualBudget, c.BudgetSupported = true, true
					c.BudgetMin = 1024
					c.BudgetMax = c.OutputMax - 1
				}
			}
		}
		if isTrue(m.EffortSupported) {
			for _, level := range anthropicEfforts {
				if slices.Contains(m.Efforts, level) {
					c.Efforts = append(c.Efforts, level)
				}
			}
			if len(c.Efforts) > 0 {
				c.Known, c.Family = true, "claude"
			}
		}
		c.EffortBudgetCompatible = c.ManualBudget && len(c.Efforts) > 0
		if c.Known {
			c.Sources = append(c.Sources, "https://platform.claude.com/docs/en/api/models/list")
		}
		return p
	}
	// Registry controls remain an upper bound. Explicit upstream declarations
	// can only narrow them, never add levels, budgets or a different native mode.
	if types := m.ThinkingTypes; types != nil {
		if p.mode == "adaptive" && isFalse(types.Adaptive) || p.mode == "manual" && isFalse(types.Enabled) {
			clearReasoning(c)
			return p
		}
		if p.offType == "disabled" && isFalse(types.Disabled) {
			c.SupportsToggle = false
			c.Mandatory = true
		}
	}
	if m.EffortSupported != nil {
		filtered := []string{}
		if *m.EffortSupported {
			for _, level := range c.Efforts {
				if slices.Contains(m.Efforts, level) {
					filtered = append(filtered, level)
				}
			}
		}
		c.Efforts = filtered
	}
	if c.BudgetWithinOutput && c.BudgetMax >= c.OutputMax {
		c.BudgetMax = c.OutputMax - 1
	}
	return p
}
