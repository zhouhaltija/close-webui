-- name: CreateUser :one
INSERT INTO users (id,username,password_hash) VALUES ($1,$2,$3) RETURNING *;
-- name: GetUserByUsername :one
SELECT * FROM users WHERE username=$1;
-- name: GetUser :one
SELECT * FROM users WHERE id=$1;
-- name: UpdatePassword :execrows
UPDATE users SET password_hash=$2 WHERE id=$1;
-- name: CreateSession :exec
INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ($1,$2,$3);
-- name: GetSession :one
SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=$1 AND expires_at>now();
-- name: DeleteSession :exec
DELETE FROM sessions WHERE token_hash=$1;
-- name: DeleteUserSessions :exec
DELETE FROM sessions WHERE user_id=$1;

-- name: ListProviders :many
SELECT * FROM providers WHERE user_id=$1 ORDER BY created_at,id;
-- name: GetProvider :one
SELECT * FROM providers WHERE id=$1 AND user_id=$2;
-- name: CreateProvider :one
INSERT INTO providers (id,user_id,name,template_id,protocol,adapter,base_url,api_key_ciphertext,enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *;
-- name: UpdateProvider :one
UPDATE providers SET name=$3,template_id=$4,protocol=$5,adapter=$6,base_url=$7,api_key_ciphertext=$8,enabled=$9,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *;
-- name: DeleteProvider :execrows
DELETE FROM providers WHERE id=$1 AND user_id=$2;

-- name: ListModels :many
SELECT * FROM models WHERE user_id=$1 ORDER BY created_at,id;
-- name: GetModel :one
SELECT * FROM models WHERE id=$1 AND user_id=$2;
-- name: CreateModel :one
INSERT INTO models (id,user_id,provider_id,model_id,name,enabled,max_output_tokens,default_reasoning) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *;
-- name: UpdateModel :one
UPDATE models SET provider_id=$3,model_id=$4,name=$5,enabled=$6,max_output_tokens=$7,default_reasoning=$8,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *;
-- name: DeleteModel :execrows
DELETE FROM models WHERE id=$1 AND user_id=$2;
-- name: GetPreferences :one
SELECT * FROM preferences WHERE user_id=$1;
-- name: UpsertPreferences :one
INSERT INTO preferences (user_id,default_model_id) VALUES ($1,$2) ON CONFLICT(user_id) DO UPDATE SET default_model_id=excluded.default_model_id RETURNING *;

-- name: ListConversations :many
SELECT * FROM conversations WHERE user_id=$1 ORDER BY updated_at DESC,id;
-- name: GetConversation :one
SELECT * FROM conversations WHERE id=$1 AND user_id=$2;
-- name: CreateConversation :one
INSERT INTO conversations (id,user_id,title) VALUES ($1,$2,$3) RETURNING *;
-- name: RenameConversation :one
UPDATE conversations SET title=$3,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *;
-- name: DeleteConversation :execrows
DELETE FROM conversations WHERE id=$1 AND user_id=$2;
-- name: ListMessages :many
SELECT * FROM messages WHERE conversation_id=$1 AND user_id=$2 ORDER BY ordinal;
