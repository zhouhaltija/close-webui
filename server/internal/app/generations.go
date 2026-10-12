package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"closewebui/server/internal/db"
	"closewebui/server/internal/security"
	"closewebui/server/internal/upstream"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Streaming persistence coordination. The request loop never writes to the
// database itself: it feeds a bounded queue and one writer goroutine owns every
// write, so batches stay ordered and a slow database applies backpressure.
const (
	// streamMergeWindow coalesces adjacent upstream fragments into one atomic
	// write. The first segment is flushed when the window elapses and is never
	// held back waiting for a large batch threshold.
	streamMergeWindow = 40 * time.Millisecond
	// streamQueueItems bounds queued fragments and streamQueueBytes bounds the
	// bytes in flight; the request loop blocks when either bound is reached.
	streamQueueItems = 128
	streamQueueBytes = 1 << 20
	// streamBatchLimit bounds the writer's own merge buffer between writes.
	streamBatchLimit = 256 << 10
)

// Byte consumption is recorded separately; the channel is only a coalesced wake
// signal. A paused request loop must recover every byte even if hundreds of
// writer releases occur before it reads one notification.
type streamCreditLedger struct {
	ready    chan struct{}
	consumed atomic.Int64
}

func newStreamCreditLedger() *streamCreditLedger {
	return &streamCreditLedger{ready: make(chan struct{}, 1)}
}
func (c *streamCreditLedger) release(n int) {
	c.consumed.Add(int64(n))
	select {
	case c.ready <- struct{}{}:
	default:
	}
}
func (c *streamCreditLedger) take() int {
	return int(c.consumed.Swap(0))
}

type generationInput struct {
	UserMessageID      string              `json:"userMessageId"`
	AssistantMessageID string              `json:"assistantMessageId"`
	Content            string              `json:"content"`
	Retry              bool                `json:"retry"`
	GenerationID       string              `json:"generationId"`
	ModelID            string              `json:"modelId"`
	Reasoning          *upstream.Reasoning `json:"reasoning,omitempty"`
}
type snapshot struct {
	ModelID              string                  `json:"modelId"`
	ProviderID           string                  `json:"providerId"`
	NativeModelID        string                  `json:"nativeModelId"`
	Protocol             string                  `json:"protocol"`
	Adapter              string                  `json:"adapter"`
	BaseURL              string                  `json:"baseUrl"`
	MaxOutputTokens      int                     `json:"maxOutputTokens"`
	Reasoning            upstream.Reasoning      `json:"reasoning"`
	DiscoveryMetadata    *upstream.ModelMetadata `json:"discoveryMetadata,omitempty"`
	DiscoveryFingerprint string                  `json:"discoveryFingerprint,omitempty"`
}
type metadataEnvelope struct {
	ProviderID            string          `json:"providerId"`
	NativeModelID         string          `json:"nativeModelId"`
	CredentialFingerprint string          `json:"credentialFingerprint"`
	Value                 json.RawMessage `json:"value"`
}
type requestError struct {
	status        int
	code, message string
}

func (e *requestError) Error() string               { return e.message }
func reject(status int, code, message string) error { return &requestError{status, code, message} }
func generationError(w http.ResponseWriter, err error) {
	var problem *requestError
	if errors.As(err, &problem) {
		failure(w, problem.status, problem.code, problem.message)
	} else {
		dbError(w, err)
	}
}

func (a *App) recoverInterrupted(ctx context.Context) error {
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollbackTransaction(tx)
	if _, err = tx.Exec(ctx, "UPDATE messages SET status='stopped' WHERE status IN ('pending','streaming')"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "UPDATE generations SET status='stopped' WHERE status IN ('pending','streaming')"); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (a *App) begin(ctx context.Context, uid, cid string, in *generationInput) (snapshot, upstream.ProviderConfig, []upstream.Message, error) {
	var snap snapshot
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		return snap, upstream.ProviderConfig{}, nil, err
	}
	defer rollbackTransaction(tx)
	var id string
	if err = tx.QueryRow(ctx, "SELECT id FROM conversations WHERE id=$1 AND user_id=$2 FOR UPDATE", cid, uid).Scan(&id); err != nil {
		return snap, upstream.ProviderConfig{}, nil, err
	}
	var exists bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM generations WHERE id=$1 OR (conversation_id=$2 AND status IN ('pending','streaming')))", in.GenerationID, cid).Scan(&exists); err != nil {
		return snap, upstream.ProviderConfig{}, nil, err
	}
	if exists {
		return snap, upstream.ProviderConfig{}, nil, reject(409, "GENERATION_CONFLICT", "该生成已提交、已取消或对话已有活动回答。")
	}
	q := a.queries.WithTx(tx)
	messages, err := q.ListMessages(ctx, db.ListMessagesParams{ConversationID: cid, UserID: uid})
	if err != nil {
		return snap, upstream.ProviderConfig{}, nil, err
	}
	if in.Retry {
		if len(messages) < 2 {
			return snap, upstream.ProviderConfig{}, nil, reject(400, "INVALID_RETRY", "没有可重试的回答。")
		}
		last, user := messages[len(messages)-1], messages[len(messages)-2]
		if last.ID != in.AssistantMessageID || last.Role != "assistant" || last.Status != "failed" || user.ID != in.UserMessageID || user.Role != "user" {
			return snap, upstream.ProviderConfig{}, nil, reject(400, "INVALID_RETRY", "仅能重试最后一条失败回答。")
		}
		var raw []byte
		if err = tx.QueryRow(ctx, "SELECT snapshot FROM generations WHERE assistant_message_id=$1 AND user_id=$2 AND conversation_id=$3 ORDER BY created_at DESC LIMIT 1", last.ID, uid, cid).Scan(&raw); err != nil {
			return snap, upstream.ProviderConfig{}, nil, err
		}
		if err = json.Unmarshal(raw, &snap); err != nil {
			return snap, upstream.ProviderConfig{}, nil, reject(500, "INVALID_SNAPSHOT", "原生成配置无法恢复。")
		}
		in.ModelID = snap.ModelID
		in.Content = user.Content
		in.Reasoning = &snap.Reasoning
	}
	m, err := q.GetModel(ctx, db.GetModelParams{ID: in.ModelID, UserID: uid})
	if err != nil {
		return snap, upstream.ProviderConfig{}, nil, err
	}
	if !m.Enabled {
		return snap, upstream.ProviderConfig{}, nil, reject(400, "MODEL_UNAVAILABLE", "原模型已停用，请配置可用模型后发送新消息。")
	}
	p, err := q.GetProvider(ctx, db.GetProviderParams{ID: m.ProviderID, UserID: uid})
	if err != nil {
		return snap, upstream.ProviderConfig{}, nil, err
	}
	provider, err := a.providerConfig(p)
	if err != nil {
		return snap, upstream.ProviderConfig{}, nil, reject(400, "PROVIDER_UNAVAILABLE", err.Error())
	}
	if in.Retry {
		if snap.ProviderID != p.ID || snap.NativeModelID != m.ModelID || snap.Protocol != p.Protocol || snap.Adapter != p.Adapter || snap.BaseURL != p.BaseUrl {
			return snap, provider, nil, reject(409, "CONFIGURATION_CHANGED", "原供应商或模型配置已改变，请发送新消息。")
		}
		if snap.DiscoveryFingerprint != "" && snap.DiscoveryFingerprint != connectionFingerprint(p) {
			return snap, provider, nil, reject(409, "CONFIGURATION_CHANGED", "原供应商连接凭据已改变，请发送新消息。")
		}
	} else {
		var reasoning upstream.Reasoning
		_ = json.Unmarshal(m.DefaultReasoning, &reasoning)
		if in.Reasoning != nil {
			reasoning = *in.Reasoning
		}
		snap = snapshot{ModelID: m.ID, ProviderID: p.ID, NativeModelID: m.ModelID, Protocol: p.Protocol, Adapter: p.Adapter, BaseURL: p.BaseUrl, MaxOutputTokens: int(m.MaxOutputTokens), Reasoning: reasoning}
		snap.DiscoveryMetadata = effectiveMetadata(p, m)
		if snap.DiscoveryMetadata != nil {
			snap.DiscoveryFingerprint = connectionFingerprint(p)
		}
		in.Reasoning = &reasoning
	}
	if err = upstream.ValidateReasoning(upstream.CapabilitiesWithMetadata(snap.Adapter, snap.Protocol, snap.NativeModelID, snap.DiscoveryMetadata), snap.Reasoning, snap.MaxOutputTokens); err != nil {
		return snap, provider, nil, reject(400, "INVALID_REASONING", err.Error())
	}
	reasoning, _ := json.Marshal(snap.Reasoning)
	rawSnap, _ := json.Marshal(snap)
	if in.Retry {
		_, err = tx.Exec(ctx, "UPDATE messages SET content='',status='pending',error_code=NULL,error_message=NULL,generation_id=$1,reasoning=$2,metadata='{}'::jsonb WHERE id=$3 AND user_id=$4 AND conversation_id=$5", in.GenerationID, reasoning, in.AssistantMessageID, uid, cid)
	} else {
		ordinal := int64(0)
		if len(messages) > 0 {
			ordinal = messages[len(messages)-1].Ordinal + 1
		}
		_, err = tx.Exec(ctx, "INSERT INTO messages(id,user_id,conversation_id,ordinal,role,content,status) VALUES($1,$2,$3,$4,'user',$5,'completed')", in.UserMessageID, uid, cid, ordinal, in.Content)
		if err != nil {
			return snap, provider, nil, err
		}
		_, err = tx.Exec(ctx, "INSERT INTO messages(id,user_id,conversation_id,ordinal,role,content,status,model_id,generation_id,reasoning) VALUES($1,$2,$3,$4,'assistant','','pending',$5,$6,$7)", in.AssistantMessageID, uid, cid, ordinal+1, m.ID, in.GenerationID, reasoning)
		if err == nil {
			_, err = tx.Exec(ctx, "UPDATE conversations SET updated_at=now() WHERE id=$1 AND user_id=$2", cid, uid)
		}
	}
	if err != nil {
		return snap, provider, nil, err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO generations(id,user_id,conversation_id,assistant_message_id,status,snapshot) VALUES($1,$2,$3,$4,'pending',$5)", in.GenerationID, uid, cid, in.AssistantMessageID, rawSnap); err != nil {
		return snap, provider, nil, err
	}
	history := make([]upstream.Message, 0, len(messages)+1)
	for _, m := range messages {
		if in.Retry && m.ID == in.AssistantMessageID {
			continue
		}
		if m.Role == "assistant" && (m.Status == "pending" || m.Status == "streaming" || m.Status == "failed" || m.Content == "") {
			continue
		}
		msg := upstream.Message{Role: m.Role, Content: m.Content}
		var envelope metadataEnvelope
		if m.Role == "assistant" && json.Unmarshal(m.Metadata, &envelope) == nil && envelope.ProviderID == p.ID && envelope.NativeModelID == snap.NativeModelID && envelope.CredentialFingerprint == security.HashToken(provider.APIKey) {
			msg.Metadata = envelope.Value
		}
		history = append(history, msg)
	}
	if !in.Retry {
		history = append(history, upstream.Message{Role: "user", Content: in.Content})
	}
	if err = tx.Commit(ctx); err != nil {
		return snap, provider, nil, err
	}
	return snap, provider, history, nil
}

var errInactive = errors.New("generation is no longer active")

func durableContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 10*time.Second)
}

// appendDelta persists one merged batch of visible text with a single atomic
// statement instead of BEGIN + two UPDATEs + COMMIT. Lock and validate the pair
// in generation → message order before either UPDATE, so an inactive or stale
// row cannot partially update its counterpart. Updates depend on that same pair
// and return success only after both rows have been persisted.
func (a *App) appendDelta(uid, cid, gid, assistantID, delta string) error {
	ctx, cancel := durableContext()
	defer cancel()
	var updated string
	var messages int
	err := a.pool.QueryRow(ctx, `WITH generation AS (
		SELECT id,assistant_message_id FROM generations
		WHERE id=$1 AND user_id=$2 AND conversation_id=$3 AND assistant_message_id=$5 AND status IN ('pending','streaming')
		FOR UPDATE
	), message AS (
		SELECT m.id FROM messages m JOIN generation g ON g.assistant_message_id=m.id
		WHERE m.id=$5 AND m.user_id=$2 AND m.conversation_id=$3 AND m.generation_id=$1 AND m.role='assistant' AND m.status IN ('pending','streaming')
		FOR UPDATE OF m
	), updated_generation AS (
		UPDATE generations g SET status='streaming' FROM message m
		WHERE g.id=$1 AND g.assistant_message_id=m.id RETURNING g.id
	), updated_message AS (
		UPDATE messages m SET content=m.content || $4,status='streaming' FROM updated_generation g
		WHERE m.id=$5 AND m.generation_id=g.id RETURNING m.id
	)
	SELECT COALESCE((SELECT id::text FROM updated_generation),''),(SELECT count(*) FROM updated_message)`, gid, uid, cid, delta, assistantID).Scan(&updated, &messages)
	if err != nil {
		return err
	}
	if updated == "" || messages != 1 {
		return errInactive
	}
	return nil
}
func (a *App) finish(uid, cid, gid, status string, problem *messageError, metadata json.RawMessage) (bool, error) {
	ctx, cancel := durableContext()
	defer cancel()
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer rollbackTransaction(tx)
	var assistantID string
	err = tx.QueryRow(ctx, "UPDATE generations SET status=$1 WHERE id=$2 AND user_id=$3 AND conversation_id=$4 AND status IN ('pending','streaming') RETURNING assistant_message_id", status, gid, uid, cid).Scan(&assistantID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var code, message *string
	if problem != nil {
		code = &problem.Code
		message = &problem.Message
	}
	if len(metadata) == 0 {
		metadata = []byte("{}")
	}
	result, err := tx.Exec(ctx, "UPDATE messages SET status=$1,error_code=$2,error_message=$3,metadata=$4 WHERE id=$5 AND user_id=$6 AND conversation_id=$7 AND generation_id=$8 AND status IN ('pending','streaming')", status, code, message, metadata, assistantID, uid, cid, gid)
	if err != nil {
		return false, err
	}
	if result.RowsAffected() != 1 {
		return false, errInactive
	}
	if err = tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

type streamUpdate struct {
	text     string
	metadata json.RawMessage
	err      error
	terminal bool
}

func (a *App) generate(w http.ResponseWriter, r *http.Request) {
	uid, cid := currentUser(r).ID, chi.URLParam(r, "id")
	var in generationInput
	if !decode(w, r, &in) {
		return
	}
	for _, id := range []*string{&in.GenerationID, &in.UserMessageID, &in.AssistantMessageID} {
		parsed, err := uuid.Parse(*id)
		if err != nil {
			failure(w, 400, "INVALID_ID", "消息和生成标识无效。")
			return
		}
		*id = parsed.String()
	}
	conversation, err := a.conversation(r, cid)
	if err != nil {
		dbError(w, err)
		return
	}
	cid = conversation.ID
	if in.UserMessageID == in.AssistantMessageID || strings.TrimSpace(in.Content) == "" || len(in.Content) > 100000 {
		failure(w, 400, "INVALID_CONTENT", "请输入有效消息，且长度不超过 100000 字节。")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	job := &running{cancel: cancel, done: make(chan struct{}), userID: uid, conversationID: cid}
	a.mu.Lock()
	_, duplicate := a.active[in.GenerationID]
	if !duplicate {
		a.active[in.GenerationID] = job
	}
	a.mu.Unlock()
	if duplicate {
		cancel()
		failure(w, 409, "GENERATION_CONFLICT", "该生成已提交。")
		return
	}
	defer func() {
		cancel()
		_, _ = a.finish(uid, cid, in.GenerationID, "stopped", nil, nil)
		a.mu.Lock()
		if a.active[in.GenerationID] == job {
			delete(a.active, in.GenerationID)
		}
		a.mu.Unlock()
		close(job.done)
	}()
	snap, provider, history, err := a.begin(ctx, uid, cid, &in)
	if err != nil {
		generationError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(200)
	rc := http.NewResponseController(w)
	if err = rc.Flush(); err != nil {
		return
	}
	// Delta emission happens on the writer goroutine while heartbeats are written
	// by this loop, so all response writes are serialized.
	var writeMu sync.Mutex
	emit := func(event any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = rc.SetWriteDeadline(time.Now().Add(15 * time.Second))
		if e := json.NewEncoder(w).Encode(event); e != nil {
			return e
		}
		return rc.Flush()
	}
	updates := make(chan streamUpdate, 16)
	go func() {
		meta, e := a.upstream.Stream(ctx, provider, upstream.ModelConfig{ModelID: snap.NativeModelID, MaxOutputTokens: snap.MaxOutputTokens, Reasoning: snap.Reasoning, Metadata: snap.DiscoveryMetadata}, history, func(text string) error {
			select {
			case updates <- streamUpdate{text: text}:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
		select {
		case updates <- streamUpdate{metadata: meta, err: e, terminal: true}:
		case <-ctx.Done():
		}
	}()
	queue := make(chan streamUpdate, streamQueueItems)
	credits := newStreamCreditLedger()
	writeErr := make(chan error, 1)
	writerExited := make(chan struct{})
	go func() {
		defer close(writerExited)
		var batch []byte
		var window <-chan time.Time
		var timer *time.Timer
		stopWindow := func() {
			if timer != nil {
				timer.Stop()
				timer = nil
			}
			window = nil
		}
		fail := func(err error) {
			select {
			case writeErr <- err:
			default:
			}
		}
		// flush persists the merged batch with one atomic statement and emits it
		// only after the database confirmed the write.
		flush := func() error {
			if len(batch) == 0 {
				return nil
			}
			text := string(batch)
			batch = batch[:0]
			if err := a.appendDelta(uid, cid, in.GenerationID, in.AssistantMessageID, text); err != nil {
				return err
			}
			return emit(map[string]any{"type": "delta", "assistantMessageId": in.AssistantMessageID, "content": text})
		}
		for {
			if len(batch) == 0 {
				select {
				case update, ok := <-queue:
					if !ok {
						return
					}
					credits.release(len(update.text))
					batch = append(batch, update.text...)
					timer = time.NewTimer(streamMergeWindow)
					window = timer.C
				}
				continue
			}
			select {
			case update, ok := <-queue:
				if !ok {
					if err := flush(); err != nil {
						fail(err)
					}
					return
				}
				credits.release(len(update.text))
				batch = append(batch, update.text...)
				if len(batch) >= streamBatchLimit {
					stopWindow()
					if err := flush(); err != nil {
						fail(err)
						return
					}
				}
			case <-window:
				stopWindow()
				if err := flush(); err != nil {
					fail(err)
					return
				}
			}
		}
	}()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	var size, pendingBytes int
	queueClosed := false
	closeQueue := func() {
		if !queueClosed {
			queueClosed = true
			close(queue)
		}
	}
	writeFailure := func() error {
		select {
		case err := <-writeErr:
			return err
		default:
			return nil
		}
	}
	// deliver hands one upstream fragment to the single writer. It blocks while
	// the bounded queue is full, so a slow database back-pressures the upstream
	// instead of queueing without limit or writing out of order.
	deliver := func(text string) bool {
		if len(text) <= streamQueueBytes {
			for pendingBytes+len(text) > streamQueueBytes {
				select {
				case <-credits.ready:
					pendingBytes -= credits.take()
				case <-writerExited:
					return false
				case <-ctx.Done():
					return false
				}
			}
		}
		pendingBytes += len(text)
		for {
			select {
			case queue <- streamUpdate{text: text}:
				return true
			case <-credits.ready:
				pendingBytes -= credits.take()
			case <-writerExited:
				return false
			case <-ctx.Done():
				return false
			}
		}
	}
	// drainQueue stops the writer after every queued batch has been persisted and
	// returns the first persistence failure, if any.
	drainQueue := func() error {
		closeQueue()
		<-writerExited
		return writeFailure()
	}
	saveFailure := func(err error) (string, error) {
		if ctx.Err() != nil || errors.Is(err, errInactive) {
			return "stopped", err
		}
		return "failed", errors.New("回答保存失败，请稍后重试。")
	}
	terminate := func(status string, e error, meta json.RawMessage) {
		var problem *messageError
		if status == "failed" {
			problem = &messageError{Code: "UPSTREAM_FAILED", Message: "回答生成失败，请重试。"}
			if e != nil && !errors.Is(e, errInactive) {
				problem.Message = e.Error()
			}
		}
		var envelope []byte
		if len(meta) > 0 {
			envelope, _ = json.Marshal(metadataEnvelope{ProviderID: snap.ProviderID, NativeModelID: snap.NativeModelID, CredentialFingerprint: security.HashToken(provider.APIKey), Value: meta})
		}
		saved, saveErr := a.finish(uid, cid, in.GenerationID, status, problem, envelope)
		if saveErr != nil || !saved {
			return
		}
		if status == "completed" {
			_ = emit(map[string]any{"type": "done", "assistantMessageId": in.AssistantMessageID})
		} else if problem != nil {
			_ = emit(map[string]any{"type": "error", "assistantMessageId": in.AssistantMessageID, "code": problem.Code, "message": problem.Message})
		}
	}
	// finalize drains every legal batch first, then persists the terminal state,
	// and only then reports done/error. A failed save can never be reported as
	// success.
	finalize := func(status string, e error, meta json.RawMessage) {
		if err := drainQueue(); err != nil {
			status, e = saveFailure(err)
		}
		terminate(status, e, meta)
	}
	for {
		select {
		case <-ctx.Done():
			finalize("stopped", ctx.Err(), nil)
			return
		case <-heartbeat.C:
			writeMu.Lock()
			_ = rc.SetWriteDeadline(time.Now().Add(15 * time.Second))
			_, err = fmt.Fprint(w, "\n")
			flushErr := rc.Flush()
			writeMu.Unlock()
			if err != nil || flushErr != nil {
				finalize("stopped", nil, nil)
				return
			}
		case err := <-writeErr:
			status, e := saveFailure(err)
			finalize(status, e, nil)
			return
		case <-credits.ready:
			// One notification can acknowledge any number of consumed fragments;
			// never discard their byte count when the request loop is busy.
			pendingBytes -= credits.take()
		case update := <-updates:
			if update.terminal {
				var status string
				var e error
				switch {
				case ctx.Err() != nil:
					status, e = "stopped", ctx.Err()
				case update.err != nil:
					status, e = "failed", update.err
				default:
					status = "completed"
				}
				finalize(status, e, update.metadata)
				return
			}
			size += len(update.text)
			if size > 8<<20 {
				finalize("failed", errors.New("回答超过大小限制。"), nil)
				return
			}
			if !deliver(update.text) {
				if err := writeFailure(); err != nil {
					status, e := saveFailure(err)
					finalize(status, e, nil)
					return
				}
				finalize("stopped", ctx.Err(), nil)
				return
			}
		}
	}
}

func (a *App) stop(w http.ResponseWriter, r *http.Request) {
	uid, cid, gid := currentUser(r).ID, chi.URLParam(r, "id"), chi.URLParam(r, "generationId")
	parsed, err := uuid.Parse(gid)
	if err != nil {
		failure(w, 400, "INVALID_ID", "生成标识无效。")
		return
	}
	gid = parsed.String()
	c, err := a.conversation(r, cid)
	if err != nil {
		dbError(w, err)
		return
	}
	cid = c.ID
	a.mu.Lock()
	job := a.active[gid]
	if job != nil && job.userID == uid && job.conversationID == cid {
		job.cancel()
	} else {
		job = nil
	}
	a.mu.Unlock()
	if job != nil {
		select {
		case <-job.done:
		case <-time.After(2 * time.Second):
		}
	}
	ctx, cancel := durableContext()
	defer cancel()
	tx, err := a.pool.Begin(ctx)
	if err != nil {
		dbError(w, err)
		return
	}
	defer rollbackTransaction(tx)
	var id string
	if err = tx.QueryRow(ctx, "SELECT id FROM conversations WHERE id=$1 AND user_id=$2 FOR UPDATE", cid, uid).Scan(&id); err != nil {
		dbError(w, err)
		return
	}
	var owner, conversation string
	err = tx.QueryRow(ctx, "SELECT user_id,conversation_id FROM generations WHERE id=$1", gid).Scan(&owner, &conversation)
	if errors.Is(err, pgx.ErrNoRows) {
		_, err = tx.Exec(ctx, "INSERT INTO generations(id,user_id,conversation_id,status) VALUES($1,$2,$3,'cancelled')", gid, uid, cid)
	} else if err == nil && (owner != uid || conversation != cid) {
		dbError(w, pgx.ErrNoRows)
		return
	}
	if err != nil {
		dbError(w, err)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		dbError(w, err)
		return
	}
	if _, err = a.finish(uid, cid, gid, "stopped", nil, nil); err != nil {
		dbError(w, err)
		return
	}
	w.WriteHeader(204)
}
