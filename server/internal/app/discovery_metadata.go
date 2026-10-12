// SPDX-License-Identifier: AGPL-3.0-only
package app

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"closewebui/server/internal/db"
	"closewebui/server/internal/security"
	"closewebui/server/internal/upstream"
)

// These are server-owned discovery facts, not a client-writable capability
// override. The digest binds the public fields to their exact connection.
type modelDiscoverySnapshot struct {
	ProviderID  string                  `json:"providerId"`
	ModelID     string                  `json:"modelId"`
	Fingerprint string                  `json:"fingerprint"`
	Metadata    *upstream.ModelMetadata `json:"metadata,omitempty"`
}

type discoveryCacheKey struct{ user, provider, fingerprint string }
type discoveryCache struct {
	at     time.Time
	models map[string]upstream.DiscoveredModel
}

const discoveryCacheTTL = 10 * time.Minute
const discoveryCacheProviders = 32
const discoveryCacheModels = 2048

var errDiscoveryChanged = errors.New("供应商连接配置已改变，请重新拉取模型。")

func connectionFingerprint(p db.Provider) string {
	// Ciphertext changes on a key update; no plaintext credential is retained.
	data, _ := json.Marshal([]string{p.UserID, p.ID, p.Protocol, p.Adapter, p.BaseUrl, p.ApiKeyCiphertext})
	return security.HashToken(string(data))
}

func discoveryBytes(p db.Provider, id string, metadata *upstream.ModelMetadata) []byte {
	if metadata == nil {
		return []byte("{}")
	}
	data, _ := json.Marshal(modelDiscoverySnapshot{ProviderID: p.ID, ModelID: id, Fingerprint: connectionFingerprint(p), Metadata: metadata})
	return data
}

func effectiveMetadata(p db.Provider, m db.Model) *upstream.ModelMetadata {
	var value modelDiscoverySnapshot
	if json.Unmarshal(m.DiscoveryMetadata, &value) != nil || value.ProviderID != p.ID || value.ModelID != m.ModelID || value.Fingerprint != connectionFingerprint(p) {
		return nil
	}
	return value.Metadata
}

func modelCapability(p db.Provider, m db.Model) upstream.Capability {
	return upstream.CapabilitiesWithMetadata(p.Adapter, p.Protocol, m.ModelID, effectiveMetadata(p, m))
}

func (a *App) cachedDiscovery(p db.Provider) (discoveryCache, bool) {
	key := discoveryCacheKey{p.UserID, p.ID, connectionFingerprint(p)}
	a.mu.Lock()
	defer a.mu.Unlock()
	value, ok := a.discovered[key]
	if ok && time.Since(value.at) > discoveryCacheTTL {
		delete(a.discovered, key)
		return discoveryCache{}, false
	}
	return value, ok
}

func (a *App) cacheDiscovery(p db.Provider, models []upstream.DiscoveredModel, preferredIDs ...string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.discovered == nil {
		a.discovered = make(map[discoveryCacheKey]discoveryCache)
	}
	key := discoveryCacheKey{p.UserID, p.ID, connectionFingerprint(p)}
	if _, ok := a.discovered[key]; !ok && len(a.discovered) >= discoveryCacheProviders {
		var oldest discoveryCacheKey
		var at time.Time
		for k, v := range a.discovered {
			if at.IsZero() || v.at.Before(at) {
				oldest, at = k, v.at
			}
		}
		delete(a.discovered, oldest)
	}
	value := discoveryCache{at: time.Now(), models: make(map[string]upstream.DiscoveredModel)}
	// A requested tail candidate must remain verifiable when the upstream list
	// is larger than our bounded cache. Prioritize it without growing the cache.
	for _, id := range preferredIDs {
		if len(value.models) >= discoveryCacheModels {
			break
		}
		// A nil-metadata entry also records an explicit absence from the full
		// upstream result, rather than an absence caused by cache truncation.
		value.models[id] = upstream.DiscoveredModel{ID: id}
		for _, m := range models {
			if m.ID == id {
				value.models[id] = m
				break
			}
		}
	}
	for _, m := range models {
		if len(value.models) >= discoveryCacheModels {
			break
		}
		value.models[m.ID] = m
	}
	a.discovered[key] = value
}

// A row lock serializes connection edits with publication. Late discoveries
// never replace metadata belonging to the newer connection or key.
func (a *App) rememberDiscovery(ctx context.Context, p db.Provider, models []upstream.DiscoveredModel, preferredIDs ...string) error {
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollbackTransaction(tx)
	var locked string
	if err = tx.QueryRow(ctx, "SELECT id FROM providers WHERE id=$1 AND user_id=$2 FOR UPDATE", p.ID, p.UserID).Scan(&locked); err != nil {
		return err
	}
	q := a.queries.WithTx(tx)
	fresh, err := q.GetProvider(ctx, db.GetProviderParams{ID: p.ID, UserID: p.UserID})
	if err != nil {
		return err
	}
	if connectionFingerprint(fresh) != connectionFingerprint(p) {
		return errDiscoveryChanged
	}
	records := make([]struct {
		ModelID  string          `json:"model_id"`
		Metadata json.RawMessage `json:"metadata"`
	}, 0, len(models))
	for _, m := range models {
		records = append(records, struct {
			ModelID  string          `json:"model_id"`
			Metadata json.RawMessage `json:"metadata"`
		}{m.ID, discoveryBytes(p, m.ID, m.Metadata)})
	}
	raw, _ := json.Marshal(records)
	if err = q.UpdateDiscoveredModelsMetadata(ctx, db.UpdateDiscoveredModelsMetadataParams{UserID: p.UserID, ProviderID: p.ID, DiscoveryRecords: raw}); err != nil {
		return err
	}
	// Hold publication across COMMIT: the row lock can be granted to the next
	// transaction before Commit returns to this goroutine. That transaction must
	// not publish its cache (or validate a model) ahead of this committed result.
	a.discoveryPublishMu.Lock()
	defer a.discoveryPublishMu.Unlock()
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	a.cacheDiscovery(p, models, preferredIDs...)
	return nil
}

func (a *App) discoverAndRemember(ctx context.Context, p db.Provider, preferredIDs ...string) ([]upstream.DiscoveredModel, error) {
	cfg, err := a.providerConfig(p)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, modelDiscoveryTimeout)
	defer cancel()
	models, err := a.upstream.Discover(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err = a.rememberDiscovery(ctx, p, models, preferredIDs...); err != nil {
		return nil, err
	}
	return models, nil
}

func (a *App) metadataForModel(ctx context.Context, p db.Provider, m db.Model) *upstream.ModelMetadata {
	if metadata := effectiveMetadata(p, m); metadata != nil {
		return metadata
	}
	needsTargetedDiscovery := false
	if cache, ok := a.cachedDiscovery(p); ok {
		if entry, found := cache.models[m.ModelID]; found {
			return entry.Metadata
		}
		if len(cache.models) < discoveryCacheModels {
			return nil
		}
		needsTargetedDiscovery = true
	}
	// Known static entries remain fully usable offline. An unregistered manual
	// ID can still gain the documented facts via a non-generating GET /models.
	if !needsTargetedDiscovery && upstream.Capabilities(p.Adapter, p.Protocol, m.ModelID).Known {
		return nil
	}
	models, err := a.discoverAndRemember(ctx, p, m.ModelID)
	if err != nil {
		return nil
	}
	for _, entry := range models {
		if entry.ID == m.ModelID {
			return entry.Metadata
		}
	}
	return nil
}

// Saving and refreshing capabilities take the same provider row lock. A model
// cannot be validated against an old key/config or overwrite a newer refresh.
func (a *App) saveValidatedModel(ctx context.Context, p db.Provider, m db.Model, create bool) (db.Model, error) {
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		return db.Model{}, err
	}
	defer rollbackTransaction(tx)
	var locked string
	if err = tx.QueryRow(ctx, "SELECT id FROM providers WHERE id=$1 AND user_id=$2 FOR UPDATE", p.ID, p.UserID).Scan(&locked); err != nil {
		return db.Model{}, err
	}
	q := a.queries.WithTx(tx)
	fresh, err := q.GetProvider(ctx, db.GetProviderParams{ID: p.ID, UserID: p.UserID})
	if err != nil {
		return db.Model{}, err
	}
	if connectionFingerprint(fresh) != connectionFingerprint(p) {
		return db.Model{}, reject(409, "CONFIGURATION_CHANGED", errDiscoveryChanged.Error())
	}
	var existing db.Model
	newBinding := create
	if !create {
		existing, err = q.GetModel(ctx, db.GetModelParams{ID: m.ID, UserID: m.UserID})
		if err != nil {
			return db.Model{}, err
		}
		newBinding = existing.ProviderID != m.ProviderID || existing.ModelID != m.ModelID
	}
	a.discoveryPublishMu.Lock()
	// A preceding discovery may have committed but still be publishing its cache.
	// The provider row lock now keeps later discoveries behind this validation.
	metadata := effectiveMetadata(p, m)
	cache, cached := a.cachedDiscovery(p)
	if cached {
		if entry, found := cache.models[m.ModelID]; found {
			metadata = entry.Metadata
		} else if newBinding {
			if len(cache.models) >= discoveryCacheModels {
				a.discoveryPublishMu.Unlock()
				return db.Model{}, reject(409, "DISCOVERY_CHANGED", "模型发现结果已更新，请重新拉取模型后保存。")
			}
			metadata = nil
		}
	}
	a.discoveryPublishMu.Unlock()
	if newBinding && !cached && metadata != nil {
		return db.Model{}, reject(409, "DISCOVERY_CHANGED", "模型发现结果已失效，请重新拉取模型后保存。")
	}
	m.DiscoveryMetadata = discoveryBytes(p, m.ModelID, metadata)
	if !newBinding {
		m.DiscoveryMetadata = existing.DiscoveryMetadata
	}
	var reasoning upstream.Reasoning
	_ = json.Unmarshal(m.DefaultReasoning, &reasoning)
	if err = upstream.ValidateReasoning(modelCapability(p, m), reasoning, int(m.MaxOutputTokens)); err != nil {
		return db.Model{}, reject(400, "INVALID_REASONING", err.Error())
	}
	var saved db.Model
	if create {
		saved, err = q.CreateModel(ctx, db.CreateModelParams{ID: m.ID, UserID: m.UserID, ProviderID: m.ProviderID, ModelID: m.ModelID, Name: m.Name, Enabled: m.Enabled, MaxOutputTokens: m.MaxOutputTokens, DefaultReasoning: m.DefaultReasoning, DiscoveryMetadata: m.DiscoveryMetadata})
	} else {
		saved, err = q.UpdateModel(ctx, db.UpdateModelParams{ID: m.ID, UserID: m.UserID, ProviderID: m.ProviderID, ModelID: m.ModelID, Name: m.Name, Enabled: m.Enabled, MaxOutputTokens: m.MaxOutputTokens, DefaultReasoning: m.DefaultReasoning, DiscoveryMetadata: m.DiscoveryMetadata})
	}
	if err != nil {
		return db.Model{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return db.Model{}, err
	}
	return saved, nil
}
