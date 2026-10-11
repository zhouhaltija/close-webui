// SPDX-License-Identifier: AGPL-3.0-only
package upstream

import (
	"encoding/json"
	"net/http"
)

type Reasoning struct {
	Enabled      *bool  `json:"enabled,omitempty"`
	Effort       string `json:"effort,omitempty"`
	BudgetTokens *int   `json:"budgetTokens,omitempty"`
}
type Capability struct {
	Family                 string   `json:"family"`
	Efforts                []string `json:"efforts"`
	SupportsToggle         bool     `json:"supportsToggle"`
	Mandatory              bool     `json:"mandatory"`
	BudgetMin              int      `json:"budgetMin"`
	BudgetMax              int      `json:"budgetMax"`
	BudgetSupported        bool     `json:"budgetSupported"`
	OutputMax              int      `json:"outputMax"`
	Sources                []string `json:"sources"`
	Known                  bool     `json:"known"`
	BudgetWithinOutput     bool     `json:"budgetWithinOutput"`
	EffortBudgetCompatible bool     `json:"effortBudgetCompatible"`
	DynamicBudget          bool     `json:"dynamicBudget"`
	ZeroBudgetDisables     bool     `json:"zeroBudgetDisables"`
	ManualBudget           bool     `json:"manualBudget"`
	EffortWhileDisabled    bool     `json:"effortWhileDisabled"`
	DisabledEffortLimited  bool     `json:"disabledEffortLimited"`
}
type Template struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Protocol string `json:"protocol"`
	Adapter  string `json:"adapter"`
	BaseURL  string `json:"baseUrl"`
}
type ProviderConfig struct{ Protocol, Adapter, BaseURL, APIKey string }
type ModelConfig struct {
	ModelID         string
	MaxOutputTokens int
	Reasoning       Reasoning
}
type Message struct {
	Role, Content string
	Metadata      json.RawMessage
}
type DiscoveredModel struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type Client struct{ http *http.Client }
