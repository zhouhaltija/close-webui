package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"closewebui/server/internal/db"
	"closewebui/server/internal/security"
	"closewebui/server/internal/upstream"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type providerView struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	TemplateID string `json:"templateId"`
	Protocol   string `json:"protocol"`
	Adapter    string `json:"adapter"`
	BaseURL    string `json:"baseUrl"`
	Enabled    bool   `json:"enabled"`
	HasKey     bool   `json:"hasKey"`
	UpdatedAt  string `json:"updatedAt"`
}

func providerDTO(p db.Provider) providerView {
	return providerView{p.ID, p.Name, p.TemplateID, p.Protocol, p.Adapter, p.BaseUrl, p.Enabled, p.ApiKeyCiphertext != "", p.UpdatedAt.UTC().Format(time.RFC3339Nano)}
}
func (a *App) listProviders(w http.ResponseWriter, r *http.Request) {
	rows, err := a.queries.ListProviders(r.Context(), currentUser(r).ID)
	if err != nil {
		dbError(w, err)
		return
	}
	result := make([]providerView, 0, len(rows))
	for _, p := range rows {
		result = append(result, providerDTO(p))
	}
	respond(w, 200, result)
}
func (a *App) provider(r *http.Request, id string) (db.Provider, error) {
	return a.queries.GetProvider(r.Context(), db.GetProviderParams{ID: id, UserID: currentUser(r).ID})
}
func (a *App) getProvider(w http.ResponseWriter, r *http.Request) {
	p, err := a.provider(r, chi.URLParam(r, "id"))
	if err != nil {
		dbError(w, err)
		return
	}
	respond(w, 200, providerDTO(p))
}
func nonempty(value string, max int) bool {
	return strings.TrimSpace(value) != "" && utf8.RuneCountInString(value) <= max && !strings.ContainsAny(value, "\x00\r\n")
}
func (a *App) saveProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	uid := currentUser(r).ID
	p := db.Provider{ID: uuid.NewString(), UserID: uid, Enabled: true, TemplateID: "custom", Adapter: "standard"}
	if id != "" {
		var err error
		p, err = a.provider(r, id)
		if err != nil {
			dbError(w, err)
			return
		}
	}
	var in struct {
		Name       *string `json:"name"`
		TemplateID *string `json:"templateId"`
		Protocol   *string `json:"protocol"`
		Adapter    *string `json:"adapter"`
		BaseURL    *string `json:"baseUrl"`
		APIKey     *string `json:"apiKey"`
		Enabled    *bool   `json:"enabled"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Name != nil {
		p.Name = strings.TrimSpace(*in.Name)
	}
	if in.TemplateID != nil {
		p.TemplateID = *in.TemplateID
	}
	if in.Protocol != nil {
		p.Protocol = *in.Protocol
	}
	if in.Adapter != nil {
		p.Adapter = *in.Adapter
	}
	if in.BaseURL != nil {
		p.BaseUrl = strings.TrimRight(strings.TrimSpace(*in.BaseURL), "/")
	}
	if in.Enabled != nil {
		p.Enabled = *in.Enabled
	}
	validProtocol := p.Protocol == "openai-chat" || p.Protocol == "openai-responses" || p.Protocol == "gemini" || p.Protocol == "anthropic"
	validAdapter := p.Adapter == "standard" || p.Adapter == "openrouter" || p.Adapter == "siliconflow" || p.Adapter == "deepseek" || p.Adapter == "qwen" || p.Adapter == "kimi" || p.Adapter == "glm"
	if !nonempty(p.Name, 80) || !validProtocol || !validAdapter {
		failure(w, 400, "INVALID_PROVIDER", "请填写有效名称、协议和参数适配类型。")
		return
	}
	u, err := url.Parse(p.BaseUrl)
	if err != nil || u.RawQuery != "" || len(p.BaseUrl) > 2048 {
		failure(w, 400, "INVALID_URL", "API 地址格式无效，请填写不含查询参数的基址。")
		return
	}
	if err = security.ValidateURL(p.BaseUrl, a.cfg.AllowedHosts); err != nil {
		failure(w, 400, "INVALID_URL", "API 地址不可用或未获服务端允许。请使用公网 HTTPS 地址。")
		return
	}
	if in.APIKey != nil && strings.TrimSpace(*in.APIKey) != "" {
		if len(*in.APIKey) > 16384 {
			failure(w, 400, "INVALID_KEY", "API 密钥过长。")
			return
		}
		p.ApiKeyCiphertext, err = a.cipher.Encrypt(strings.TrimSpace(*in.APIKey), uid+":"+p.ID)
		if err != nil {
			failure(w, 500, "ENCRYPTION_ERROR", "无法加密保存密钥。")
			return
		}
	}
	if id == "" {
		p, err = a.queries.CreateProvider(r.Context(), db.CreateProviderParams{ID: p.ID, UserID: uid, Name: p.Name, TemplateID: p.TemplateID, Protocol: p.Protocol, Adapter: p.Adapter, BaseUrl: p.BaseUrl, ApiKeyCiphertext: p.ApiKeyCiphertext, Enabled: p.Enabled})
	} else {
		p, err = a.queries.UpdateProvider(r.Context(), db.UpdateProviderParams{ID: p.ID, UserID: uid, Name: p.Name, TemplateID: p.TemplateID, Protocol: p.Protocol, Adapter: p.Adapter, BaseUrl: p.BaseUrl, ApiKeyCiphertext: p.ApiKeyCiphertext, Enabled: p.Enabled})
	}
	if err != nil {
		dbError(w, err)
		return
	}
	status := 200
	if id == "" {
		status = 201
	}
	respond(w, status, providerDTO(p))
}
func (a *App) deleteProvider(w http.ResponseWriter, r *http.Request) {
	id, uid := chi.URLParam(r, "id"), currentUser(r).ID
	p, err := a.provider(r, id)
	if err != nil {
		dbError(w, err)
		return
	}
	id = p.ID
	var active bool
	err = a.pool.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM generations WHERE user_id=$1 AND status IN ('pending','streaming') AND snapshot->>'providerId'=$2)", uid, id).Scan(&active)
	if err != nil {
		dbError(w, err)
		return
	}
	if active {
		failure(w, 409, "ACTIVE_GENERATION", "请先停止使用该供应商的回答。")
		return
	}
	n, err := a.queries.DeleteProvider(r.Context(), db.DeleteProviderParams{ID: id, UserID: uid})
	if err != nil {
		dbError(w, err)
		return
	}
	if n == 0 {
		dbError(w, pgx.ErrNoRows)
		return
	}
	w.WriteHeader(204)
}
func (a *App) providerConfig(p db.Provider) (upstream.ProviderConfig, error) {
	if !p.Enabled || p.ApiKeyCiphertext == "" {
		return upstream.ProviderConfig{}, errors.New("供应商已停用或尚未配置 API 密钥。")
	}
	key, err := a.cipher.Decrypt(p.ApiKeyCiphertext, p.UserID+":"+p.ID)
	if err != nil {
		return upstream.ProviderConfig{}, errors.New("供应商密钥无法解密，请重新填写。")
	}
	return upstream.ProviderConfig{Protocol: p.Protocol, Adapter: p.Adapter, BaseURL: p.BaseUrl, APIKey: key}, nil
}
func (a *App) discover(w http.ResponseWriter, r *http.Request) {
	p, err := a.provider(r, chi.URLParam(r, "id"))
	if err != nil {
		dbError(w, err)
		return
	}
	_, err = a.providerConfig(p)
	if err != nil {
		failure(w, 400, "PROVIDER_UNAVAILABLE", err.Error())
		return
	}
	models, err := a.discoverAndRemember(r.Context(), p)
	if err != nil {
		failure(w, 502, "DISCOVERY_FAILED", "无法获取模型列表，可保留配置并手动添加模型。")
		return
	}
	// Preserve the legacy id/name array; metadata is published only through the
	// candidate DTO and server-owned persistence.
	legacy := make([]struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}, 0, len(models))
	for _, m := range models {
		legacy = append(legacy, struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}{m.ID, m.Name})
	}
	respond(w, 200, legacy)
}

type modelView struct {
	ID               string              `json:"id"`
	ProviderID       string              `json:"providerId"`
	ModelID          string              `json:"modelId"`
	Name             string              `json:"name"`
	Enabled          bool                `json:"enabled"`
	MaxOutputTokens  int32               `json:"maxOutputTokens"`
	DefaultReasoning upstream.Reasoning  `json:"defaultReasoning"`
	Capabilities     upstream.Capability `json:"capabilities"`
}

func (a *App) modelDTO(r *http.Request, m db.Model) (modelView, error) {
	p, err := a.provider(r, m.ProviderID)
	if err != nil {
		return modelView{}, err
	}
	var reasoning upstream.Reasoning
	_ = json.Unmarshal(m.DefaultReasoning, &reasoning)
	return modelView{m.ID, m.ProviderID, m.ModelID, m.Name, m.Enabled, m.MaxOutputTokens, reasoning, modelCapability(p, m)}, nil
}
func (a *App) model(r *http.Request, id string) (db.Model, error) {
	return a.queries.GetModel(r.Context(), db.GetModelParams{ID: id, UserID: currentUser(r).ID})
}
func (a *App) listModels(w http.ResponseWriter, r *http.Request) {
	rows, err := a.queries.ListModels(r.Context(), currentUser(r).ID)
	if err != nil {
		dbError(w, err)
		return
	}
	result := make([]modelView, 0, len(rows))
	for _, m := range rows {
		v, err := a.modelDTO(r, m)
		if err != nil {
			dbError(w, err)
			return
		}
		result = append(result, v)
	}
	respond(w, 200, result)
}
func (a *App) getModel(w http.ResponseWriter, r *http.Request) {
	m, err := a.model(r, chi.URLParam(r, "id"))
	if err != nil {
		dbError(w, err)
		return
	}
	v, err := a.modelDTO(r, m)
	if err != nil {
		dbError(w, err)
		return
	}
	respond(w, 200, v)
}
func (a *App) saveModel(w http.ResponseWriter, r *http.Request) {
	id, uid := chi.URLParam(r, "id"), currentUser(r).ID
	m := db.Model{ID: uuid.NewString(), UserID: uid, Enabled: true, MaxOutputTokens: 4096, DefaultReasoning: []byte("{}")}
	if id != "" {
		var err error
		m, err = a.model(r, id)
		if err != nil {
			dbError(w, err)
			return
		}
	}
	var in struct {
		ProviderID       *string             `json:"providerId"`
		ModelID          *string             `json:"modelId"`
		Name             *string             `json:"name"`
		Enabled          *bool               `json:"enabled"`
		MaxOutputTokens  *int32              `json:"maxOutputTokens"`
		DefaultReasoning *upstream.Reasoning `json:"defaultReasoning"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.ProviderID != nil {
		m.ProviderID = *in.ProviderID
	}
	if in.ModelID != nil {
		m.ModelID = strings.TrimSpace(*in.ModelID)
	}
	if in.Name != nil {
		m.Name = strings.TrimSpace(*in.Name)
	}
	if in.Enabled != nil {
		m.Enabled = *in.Enabled
	}
	if in.MaxOutputTokens != nil {
		m.MaxOutputTokens = *in.MaxOutputTokens
	}
	if in.DefaultReasoning != nil {
		m.DefaultReasoning, _ = json.Marshal(in.DefaultReasoning)
	}
	if !nonempty(m.ModelID, 200) || !nonempty(m.Name, 80) {
		failure(w, 400, "INVALID_MODEL", "请填写有效的模型 ID 和名称。")
		return
	}
	p, err := a.provider(r, m.ProviderID)
	if err != nil {
		dbError(w, err)
		return
	}
	metadata := a.metadataForModel(r.Context(), p, m)
	m.DiscoveryMetadata = discoveryBytes(p, m.ModelID, metadata)
	cap := upstream.CapabilitiesWithMetadata(p.Adapter, p.Protocol, m.ModelID, metadata)
	var reasoning upstream.Reasoning
	_ = json.Unmarshal(m.DefaultReasoning, &reasoning)
	if m.MaxOutputTokens <= 0 || m.MaxOutputTokens > 262144 {
		failure(w, 400, "INVALID_OUTPUT_LIMIT", "输出 token 上限无效。")
		return
	}
	if err = upstream.ValidateReasoning(cap, reasoning, int(m.MaxOutputTokens)); err != nil {
		failure(w, 400, "INVALID_REASONING", err.Error())
		return
	}
	m, err = a.saveValidatedModel(r.Context(), p, m, id == "")
	if err != nil {
		generationError(w, err)
		return
	}
	v, err := a.modelDTO(r, m)
	if err != nil {
		dbError(w, err)
		return
	}
	status := 200
	if id == "" {
		status = 201
	}
	respond(w, status, v)
}
func (a *App) deleteModel(w http.ResponseWriter, r *http.Request) {
	id, uid := chi.URLParam(r, "id"), currentUser(r).ID
	m, err := a.model(r, id)
	if err != nil {
		dbError(w, err)
		return
	}
	id = m.ID
	var active bool
	err = a.pool.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM generations WHERE user_id=$1 AND status IN ('pending','streaming') AND snapshot->>'modelId'=$2)", uid, id).Scan(&active)
	if err != nil {
		dbError(w, err)
		return
	}
	if active {
		failure(w, 409, "ACTIVE_GENERATION", "请先停止使用该模型的回答。")
		return
	}
	n, err := a.queries.DeleteModel(r.Context(), db.DeleteModelParams{ID: id, UserID: uid})
	if err != nil {
		dbError(w, err)
		return
	}
	if n == 0 {
		dbError(w, pgx.ErrNoRows)
		return
	}
	w.WriteHeader(204)
}
func (a *App) preferences(w http.ResponseWriter, r *http.Request) {
	uid := currentUser(r).ID
	if r.Method == "PATCH" {
		var in struct {
			DefaultModelID *string `json:"defaultModelId"`
		}
		if !decode(w, r, &in) {
			return
		}
		if in.DefaultModelID != nil {
			if _, err := a.model(r, *in.DefaultModelID); err != nil {
				dbError(w, err)
				return
			}
		}
		v, err := a.queries.UpsertPreferences(r.Context(), db.UpsertPreferencesParams{UserID: uid, DefaultModelID: in.DefaultModelID})
		if err != nil {
			dbError(w, err)
			return
		}
		respond(w, 200, map[string]any{"defaultModelId": v.DefaultModelID})
		return
	}
	v, err := a.queries.GetPreferences(r.Context(), uid)
	if errors.Is(err, pgx.ErrNoRows) {
		respond(w, 200, map[string]any{"defaultModelId": nil})
		return
	}
	if err != nil {
		dbError(w, err)
		return
	}
	respond(w, 200, map[string]any{"defaultModelId": v.DefaultModelID})
}
