package app

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"closewebui/server/internal/db"
	"closewebui/server/internal/upstream"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type conversationView struct {
	ID        string        `json:"id"`
	Title     string        `json:"title"`
	CreatedAt time.Time     `json:"createdAt"`
	UpdatedAt time.Time     `json:"updatedAt"`
	Messages  []messageView `json:"messages,omitempty"`
}
type messageView struct {
	ID             string              `json:"id"`
	ConversationID string              `json:"conversationId"`
	Role           string              `json:"role"`
	Content        string              `json:"content"`
	Status         string              `json:"status"`
	CreatedAt      time.Time           `json:"createdAt"`
	Error          *messageError       `json:"error,omitempty"`
	ModelID        *string             `json:"modelId,omitempty"`
	GenerationID   *string             `json:"generationId,omitempty"`
	Reasoning      *upstream.Reasoning `json:"reasoning,omitempty"`
}
type messageError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func conversationDTO(c db.Conversation) conversationView {
	return conversationView{ID: c.ID, Title: c.Title, CreatedAt: c.CreatedAt, UpdatedAt: c.UpdatedAt}
}
func messageDTO(m db.Message) messageView {
	v := messageView{ID: m.ID, ConversationID: m.ConversationID, Role: m.Role, Content: m.Content, Status: m.Status, CreatedAt: m.CreatedAt, ModelID: m.ModelID, GenerationID: m.GenerationID}
	if m.ErrorCode != nil && m.ErrorMessage != nil {
		v.Error = &messageError{*m.ErrorCode, *m.ErrorMessage}
	}
	if m.ModelID != nil {
		var r upstream.Reasoning
		_ = json.Unmarshal(m.Reasoning, &r)
		v.Reasoning = &r
	}
	return v
}
func (a *App) conversation(r *http.Request, id string) (db.Conversation, error) {
	return a.queries.GetConversation(r.Context(), db.GetConversationParams{ID: id, UserID: currentUser(r).ID})
}
func (a *App) listConversations(w http.ResponseWriter, r *http.Request) {
	rows, err := a.queries.ListConversations(r.Context(), currentUser(r).ID)
	if err != nil {
		dbError(w, err)
		return
	}
	list := make([]conversationView, 0, len(rows))
	for _, c := range rows {
		list = append(list, conversationDTO(c))
	}
	respond(w, 200, list)
}
func readTitle(w http.ResponseWriter, r *http.Request) (string, bool) {
	var in struct {
		Title string `json:"title"`
	}
	if !decode(w, r, &in) {
		return "", false
	}
	in.Title = strings.TrimSpace(in.Title)
	if in.Title == "" || utf8.RuneCountInString(in.Title) > 80 {
		failure(w, 400, "INVALID_TITLE", "标题需为 1–80 个字符。")
		return "", false
	}
	return in.Title, true
}
func (a *App) createConversation(w http.ResponseWriter, r *http.Request) {
	title, ok := readTitle(w, r)
	if !ok {
		return
	}
	c, err := a.queries.CreateConversation(r.Context(), db.CreateConversationParams{ID: uuid.NewString(), UserID: currentUser(r).ID, Title: title})
	if err != nil {
		dbError(w, err)
		return
	}
	v := conversationDTO(c)
	respond(w, 201, struct {
		conversationView
		Messages []messageView `json:"messages"`
	}{v, []messageView{}})
}
func (a *App) getConversation(w http.ResponseWriter, r *http.Request) {
	c, err := a.conversation(r, chi.URLParam(r, "id"))
	if err != nil {
		dbError(w, err)
		return
	}
	messages, err := a.queries.ListMessages(r.Context(), db.ListMessagesParams{ConversationID: c.ID, UserID: c.UserID})
	if err != nil {
		dbError(w, err)
		return
	}
	list := make([]messageView, 0, len(messages))
	for _, m := range messages {
		list = append(list, messageDTO(m))
	}
	respond(w, 200, struct {
		conversationView
		Messages []messageView `json:"messages"`
	}{conversationDTO(c), list})
}
func (a *App) renameConversation(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if _, err := a.conversation(r, id); err != nil {
		dbError(w, err)
		return
	}
	title, ok := readTitle(w, r)
	if !ok {
		return
	}
	c, err := a.queries.RenameConversation(r.Context(), db.RenameConversationParams{ID: id, UserID: currentUser(r).ID, Title: title})
	if err != nil {
		dbError(w, err)
		return
	}
	respond(w, 200, conversationDTO(c))
}
func (a *App) deleteConversation(w http.ResponseWriter, r *http.Request) {
	id, uid := chi.URLParam(r, "id"), currentUser(r).ID
	c, err := a.conversation(r, id)
	if err != nil {
		dbError(w, err)
		return
	}
	id = c.ID
	a.mu.Lock()
	for _, job := range a.active {
		if job.userID == uid && job.conversationID == id {
			job.cancel()
		}
	}
	a.mu.Unlock()
	n, err := a.queries.DeleteConversation(r.Context(), db.DeleteConversationParams{ID: id, UserID: uid})
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
