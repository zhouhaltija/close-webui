package app

import (
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"closewebui/server/internal/db"
	"closewebui/server/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var usernamePattern = regexp.MustCompile(`^[a-z0-9_-]{3,32}$`)

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func validPassword(password string) bool { return len(password) >= 12 && len(password) <= 128 }
func (a *App) authCapacity(w http.ResponseWriter, r *http.Request) (func(), bool) {
	a.mu.Lock()
	now := time.Now()
	ip := remoteIP(r)
	bucket := a.rates[ip]
	if now.Sub(bucket.start) > time.Minute {
		bucket = rateWindow{start: now}
	}
	bucket.attempts++
	a.rates[ip] = bucket
	if len(a.rates) > 1000 {
		for k, v := range a.rates {
			if now.Sub(v.start) > time.Minute {
				delete(a.rates, k)
			}
		}
	}
	a.mu.Unlock()
	if bucket.attempts > 20 {
		failure(w, 429, "RATE_LIMITED", "操作过于频繁，请稍后重试。")
		return nil, false
	}
	select {
	case a.authSlots <- struct{}{}:
		return func() { <-a.authSlots }, true
	default:
		failure(w, 429, "RATE_LIMITED", "登录服务繁忙，请稍后重试。")
		return nil, false
	}
}
func (a *App) cookie(w http.ResponseWriter, token string, expires time.Time) {
	c := &http.Cookie{Name: "closewebui_session", Value: token, Path: "/", HttpOnly: true, Secure: a.cfg.SecureCookies, SameSite: http.SameSiteLaxMode, Expires: expires, MaxAge: 7 * 24 * 60 * 60}
	if token == "" {
		c.MaxAge = -1
	}
	http.SetCookie(w, c)
}
func (a *App) register(w http.ResponseWriter, r *http.Request) {
	var in credentials
	if !decode(w, r, &in) {
		return
	}
	in.Username = strings.ToLower(strings.TrimSpace(in.Username))
	if !usernamePattern.MatchString(in.Username) || !validPassword(in.Password) {
		failure(w, 400, "INVALID_CREDENTIALS", "用户名需为 3–32 位字母、数字、下划线或短横线；密码需为 12–128 字节。")
		return
	}
	release, ok := a.authCapacity(w, r)
	if !ok {
		return
	}
	defer release()
	hash, err := security.HashPassword(in.Password)
	if err != nil {
		failure(w, 500, "AUTH_ERROR", "账号创建失败。")
		return
	}
	token, err := security.RandomToken()
	if err != nil {
		failure(w, 500, "AUTH_ERROR", "会话创建失败。")
		return
	}
	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		dbError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	q := a.queries.WithTx(tx)
	u, err := q.CreateUser(r.Context(), db.CreateUserParams{ID: uuid.NewString(), Username: in.Username, PasswordHash: hash})
	if err != nil {
		dbError(w, err)
		return
	}
	expires := time.Now().Add(7 * 24 * time.Hour)
	if err = q.CreateSession(r.Context(), db.CreateSessionParams{TokenHash: security.HashToken(token), UserID: u.ID, ExpiresAt: expires}); err != nil {
		dbError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		dbError(w, err)
		return
	}
	a.cookie(w, token, expires)
	respond(w, 201, map[string]string{"id": u.ID, "username": u.Username})
}
func (a *App) login(w http.ResponseWriter, r *http.Request) {
	var in credentials
	if !decode(w, r, &in) {
		return
	}
	in.Username = strings.ToLower(strings.TrimSpace(in.Username))
	if !usernamePattern.MatchString(in.Username) || !validPassword(in.Password) {
		failure(w, 400, "INVALID_CREDENTIALS", "用户名或密码格式无效。")
		return
	}
	release, ok := a.authCapacity(w, r)
	if !ok {
		return
	}
	defer release()
	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		dbError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	var u db.User
	err = tx.QueryRow(r.Context(), "SELECT id,username,password_hash,created_at FROM users WHERE username=$1 FOR UPDATE", in.Username).Scan(&u.ID, &u.Username, &u.PasswordHash, &u.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		_ = security.VerifyPassword(in.Password, a.dummyHash)
		failure(w, 401, "INVALID_CREDENTIALS", "用户名或密码不正确。")
		return
	}
	if err != nil {
		dbError(w, err)
		return
	}
	if !security.VerifyPassword(in.Password, u.PasswordHash) {
		failure(w, 401, "INVALID_CREDENTIALS", "用户名或密码不正确。")
		return
	}
	token, err := security.RandomToken()
	if err != nil {
		failure(w, 500, "AUTH_ERROR", "会话创建失败。")
		return
	}
	expires := time.Now().Add(7 * 24 * time.Hour)
	if err = a.queries.WithTx(tx).CreateSession(r.Context(), db.CreateSessionParams{TokenHash: security.HashToken(token), UserID: u.ID, ExpiresAt: expires}); err != nil {
		dbError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		dbError(w, err)
		return
	}
	a.cookie(w, token, expires)
	respond(w, 200, map[string]string{"id": u.ID, "username": u.Username})
}
func (a *App) cancelUser(id string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, job := range a.active {
		if job.userID == id {
			job.cancel()
		}
	}
}
func (a *App) logout(w http.ResponseWriter, r *http.Request) {
	c, _ := r.Cookie("closewebui_session")
	if err := a.queries.DeleteSession(r.Context(), security.HashToken(c.Value)); err != nil {
		dbError(w, err)
		return
	}
	a.cancelUser(currentUser(r).ID)
	a.cookie(w, "", time.Unix(1, 0))
	w.WriteHeader(204)
}
func (a *App) password(w http.ResponseWriter, r *http.Request) {
	var in struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !validPassword(in.NewPassword) || len(in.CurrentPassword) > 128 {
		failure(w, 400, "INVALID_PASSWORD", "新密码需为 12–128 字节。")
		return
	}
	release, ok := a.authCapacity(w, r)
	if !ok {
		return
	}
	defer release()
	tx, err := a.pool.Begin(r.Context())
	if err != nil {
		dbError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	id := currentUser(r).ID
	var hash string
	if err = tx.QueryRow(r.Context(), "SELECT password_hash FROM users WHERE id=$1 FOR UPDATE", id).Scan(&hash); err != nil {
		dbError(w, err)
		return
	}
	if !security.VerifyPassword(in.CurrentPassword, hash) {
		failure(w, 400, "INVALID_PASSWORD", "当前密码不正确。")
		return
	}
	hash, err = security.HashPassword(in.NewPassword)
	if err != nil {
		failure(w, 500, "AUTH_ERROR", "密码修改失败。")
		return
	}
	q := a.queries.WithTx(tx)
	if _, err = q.UpdatePassword(r.Context(), db.UpdatePasswordParams{ID: id, PasswordHash: hash}); err != nil {
		dbError(w, err)
		return
	}
	if err = q.DeleteUserSessions(r.Context(), id); err != nil {
		dbError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		dbError(w, err)
		return
	}
	a.cancelUser(id)
	a.cookie(w, "", time.Unix(1, 0))
	w.WriteHeader(204)
}
