// SPDX-License-Identifier: AGPL-3.0-only
package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"closewebui/server/internal/db"
	"closewebui/server/internal/upstream"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// modelDiscoveryTimeout bounds one upstream discovery attempt. It is a variable
// so tests can exercise the timeout path without waiting the real deadline.
var modelDiscoveryTimeout = 30 * time.Second

const maxBatchModels = 100

type modelRecommendedDefaults struct {
	MaxOutputTokens  int                `json:"maxOutputTokens"`
	DefaultReasoning upstream.Reasoning `json:"defaultReasoning"`
}

// candidateModel is one model the user may add. It carries only the fields the
// interface needs; the raw upstream response is never forwarded. Notes keep the
// catalog's availability caveat, so a listed candidate is never read as proof
// that the account may use it.
type candidateModel struct {
	ID                  string                   `json:"id"`
	Name                string                   `json:"name"`
	Capabilities        upstream.Capability      `json:"capabilities"`
	RecommendedDefaults modelRecommendedDefaults `json:"recommendedDefaults"`
	Notes               string                   `json:"notes,omitempty"`
}

type modelCandidatesResponse struct {
	Source         string           `json:"source"`
	CatalogVersion string           `json:"catalogVersion"`
	Warning        string           `json:"warning"`
	Models         []candidateModel `json:"models"`
}

type modelCatalogResponse struct {
	CatalogVersion string                  `json:"catalogVersion"`
	Adapter        string                  `json:"adapter"`
	Protocol       string                  `json:"protocol"`
	Models         []upstream.CatalogEntry `json:"models"`
}

type batchModelResult struct {
	ModelID string `json:"modelId"`
	ID      string `json:"id,omitempty"`
	Status  string `json:"status"`
	Error   string `json:"error,omitempty"`
}

func recommendedDefaultsFor(c upstream.Capability) modelRecommendedDefaults {
	return modelRecommendedDefaults{MaxOutputTokens: c.RecommendedOutputTokens(), DefaultReasoning: upstream.Reasoning{}}
}

func candidateFor(p db.Provider, m upstream.DiscoveredModel) candidateModel {
	name := strings.TrimSpace(m.Name)
	notes := ""
	if entry, ok := upstream.CatalogEntryFor(p.Adapter, p.Protocol, m.ID); ok {
		notes = entry.Notes
		if name == "" || name == m.ID {
			name = entry.Name
		}
	}
	if name == "" {
		name = m.ID
	}
	capability := upstream.Capabilities(p.Adapter, p.Protocol, m.ID)
	return candidateModel{ID: m.ID, Name: name, Capabilities: capability, RecommendedDefaults: recommendedDefaultsFor(capability), Notes: notes}
}

func catalogCandidates(p db.Provider) []candidateModel {
	entries := upstream.CatalogFor(p.Adapter, p.Protocol)
	models := make([]candidateModel, 0, len(entries))
	for _, entry := range entries {
		models = append(models, candidateModel{ID: entry.ID, Name: entry.Name, Capabilities: entry.Capabilities, RecommendedDefaults: recommendedDefaultsFor(entry.Capabilities), Notes: entry.Notes})
	}
	return models
}

// httpStatusFromError extracts the upstream status code carried by the client's
// error text, so 401/403 can be reported as credential problems.
func httpStatusFromError(message string) (int, bool) {
	const prefix = "上游供应商返回 HTTP "
	if !strings.HasPrefix(message, prefix) {
		return 0, false
	}
	code, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(message, prefix)))
	if err != nil {
		return 0, false
	}
	return code, true
}

// discoveryWarning states the real reason discovery did not produce a list.
// It never claims a connection succeeded.
func discoveryWarning(err error, count int) string {
	if err == nil {
		if count == 0 {
			return "上游返回空模型列表，可参考下方内置候选或手动填写模型 ID。"
		}
		return ""
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "上游连接超时，请检查网络或稍后重试。"
	}
	if errors.Is(err, context.Canceled) {
		return "请求已取消，请重新拉取模型。"
	}
	message := err.Error()
	if code, ok := httpStatusFromError(message); ok {
		switch code {
		case 401:
			return "上游凭据无效（HTTP 401），请检查 API 密钥是否正确。"
		case 403:
			return "上游拒绝访问（HTTP 403），请检查密钥权限或账号是否可用该接口。"
		default:
			return "上游模型接口返回 HTTP " + strconv.Itoa(code) + "，无法获取模型列表。"
		}
	}
	switch {
	case strings.Contains(message, "格式无效"):
		return "上游响应格式无效，无法解析模型列表。"
	case strings.Contains(message, "连接上游供应商失败"):
		return "无法连接上游供应商，请检查 API 地址与网络。"
	case strings.Contains(message, "读取上游模型列表失败"), strings.Contains(message, "超过大小限制"), strings.Contains(message, "超过分页限制"), strings.Contains(message, "分页"):
		return "上游模型列表读取不完整，请稍后重试或手动填写。"
	case strings.Contains(message, "上游模型列表返回错误"):
		return "上游模型接口返回错误，请检查凭据与地址。"
	default:
		return "无法获取上游模型列表，可参考下方内置候选或手动填写模型 ID。"
	}
}

// modelCandidates tries the live upstream first and falls back to the built-in
// catalog, always naming the actual source and reason.
func (a *App) modelCandidates(w http.ResponseWriter, r *http.Request) {
	p, err := a.provider(r, chi.URLParam(r, "id"))
	if err != nil {
		dbError(w, err)
		return
	}
	cfg, cfgErr := a.providerConfig(p)
	if cfgErr != nil {
		respond(w, 200, modelCandidatesResponse{Source: "catalog", CatalogVersion: upstream.CatalogVersion(), Warning: cfgErr.Error() + "以下为内置候选。", Models: catalogCandidates(p)})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), modelDiscoveryTimeout)
	defer cancel()
	models, err := a.upstream.Discover(ctx, cfg)
	if err != nil || len(models) == 0 {
		warning := discoveryWarning(err, len(models))
		if warning == "" {
			warning = "无法获取上游模型列表，可参考下方内置候选或手动填写模型 ID。"
		}
		respond(w, 200, modelCandidatesResponse{Source: "catalog", CatalogVersion: upstream.CatalogVersion(), Warning: warning, Models: catalogCandidates(p)})
		return
	}
	candidates := make([]candidateModel, 0, len(models))
	for _, m := range models {
		candidates = append(candidates, candidateFor(p, m))
	}
	respond(w, 200, modelCandidatesResponse{Source: "upstream", CatalogVersion: upstream.CatalogVersion(), Models: candidates})
}

// modelCatalog is fully offline: it only reports the built-in candidates
// compatible with this provider's adapter and protocol.
func (a *App) modelCatalog(w http.ResponseWriter, r *http.Request) {
	p, err := a.provider(r, chi.URLParam(r, "id"))
	if err != nil {
		dbError(w, err)
		return
	}
	respond(w, 200, modelCatalogResponse{CatalogVersion: upstream.CatalogVersion(), Adapter: p.Adapter, Protocol: p.Protocol, Models: upstream.CatalogFor(p.Adapter, p.Protocol)})
}

type batchModelItem struct {
	ModelID          string              `json:"modelId"`
	Name             *string             `json:"name"`
	MaxOutputTokens  *int32              `json:"maxOutputTokens"`
	Enabled          *bool               `json:"enabled"`
	DefaultReasoning *upstream.Reasoning `json:"defaultReasoning"`
}

// batchModels adds several models with the same validation as a single save.
// Existing rows keep their user overrides; one failing item never fails the rest.
func (a *App) batchModels(w http.ResponseWriter, r *http.Request) {
	p, err := a.provider(r, chi.URLParam(r, "id"))
	if err != nil {
		dbError(w, err)
		return
	}
	var in struct {
		Models []batchModelItem `json:"models"`
	}
	if !decode(w, r, &in) {
		return
	}
	if len(in.Models) == 0 {
		failure(w, 400, "INVALID_REQUEST", "请至少选择一个模型。")
		return
	}
	if len(in.Models) > maxBatchModels {
		failure(w, 400, "TOO_MANY_MODELS", "一次最多添加 100 个模型。")
		return
	}
	uid := currentUser(r).ID
	results := make([]batchModelResult, 0, len(in.Models))
	for _, item := range in.Models {
		results = append(results, a.batchOneModel(r, p, uid, item))
	}
	respond(w, 200, map[string]any{"results": results})
}

func (a *App) batchOneModel(r *http.Request, p db.Provider, uid string, item batchModelItem) batchModelResult {
	fail := func(message string) batchModelResult {
		return batchModelResult{ModelID: strings.TrimSpace(item.ModelID), Status: "failed", Error: message}
	}
	modelID := strings.TrimSpace(item.ModelID)
	if !nonempty(modelID, 200) {
		return fail("请填写有效的模型 ID。")
	}
	name := ""
	if item.Name != nil {
		name = strings.TrimSpace(*item.Name)
	}
	if name == "" {
		if catalogName, ok := upstream.CatalogName(p.Adapter, p.Protocol, modelID); ok {
			name = catalogName
		} else {
			name = modelID
		}
	}
	if !nonempty(name, 80) {
		return fail("请填写有效的模型 ID 和名称。")
	}
	capability := upstream.Capabilities(p.Adapter, p.Protocol, modelID)
	reasoning := upstream.Reasoning{}
	if item.DefaultReasoning != nil {
		reasoning = *item.DefaultReasoning
	}
	maxOutput := int32(capability.RecommendedOutputTokens())
	if item.MaxOutputTokens != nil {
		maxOutput = *item.MaxOutputTokens
	}
	if maxOutput <= 0 || maxOutput > 262144 {
		return fail("输出 token 上限无效。")
	}
	if err := upstream.ValidateReasoning(capability, reasoning, int(maxOutput)); err != nil {
		return fail(err.Error())
	}
	enabled := true
	if item.Enabled != nil {
		enabled = *item.Enabled
	}
	var existing string
	err := a.pool.QueryRow(r.Context(), "SELECT id FROM models WHERE user_id=$1 AND provider_id=$2 AND model_id=$3", uid, p.ID, modelID).Scan(&existing)
	switch {
	case err == nil:
		return batchModelResult{ModelID: modelID, ID: existing, Status: "exists"}
	case !errors.Is(err, pgx.ErrNoRows):
		return fail("读取已有模型失败，请稍后重试。")
	}
	reasoningBytes, err := json.Marshal(reasoning)
	if err != nil {
		return fail("思考参数无效。")
	}
	created, err := a.queries.CreateModel(r.Context(), db.CreateModelParams{ID: uuid.NewString(), UserID: uid, ProviderID: p.ID, ModelID: modelID, Name: name, Enabled: enabled, MaxOutputTokens: maxOutput, DefaultReasoning: reasoningBytes})
	if err != nil {
		return fail("保存模型失败，请稍后重试。")
	}
	return batchModelResult{ModelID: modelID, ID: created.ID, Status: "added"}
}
