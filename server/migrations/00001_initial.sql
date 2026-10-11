-- +goose Up
CREATE TABLE users (
 id uuid PRIMARY KEY,
 username text NOT NULL UNIQUE,
 password_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
 token_hash text PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);
CREATE TABLE providers (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name text NOT NULL,
 template_id text NOT NULL,
 protocol text NOT NULL CHECK (protocol IN ('openai-chat','openai-responses','gemini','anthropic')),
 adapter text NOT NULL,
 base_url text NOT NULL,
 api_key_ciphertext text NOT NULL DEFAULT '',
 enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (id,user_id)
);
CREATE INDEX providers_user_id_idx ON providers(user_id);
CREATE TABLE models (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider_id uuid NOT NULL,
 model_id text NOT NULL,
 name text NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 max_output_tokens integer NOT NULL CHECK (max_output_tokens > 0),
 default_reasoning jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (provider_id,user_id) REFERENCES providers(id,user_id) ON DELETE CASCADE,
 UNIQUE (id,user_id),
 UNIQUE (user_id,provider_id,model_id)
);
CREATE INDEX models_user_id_idx ON models(user_id);
CREATE TABLE preferences (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 default_model_id uuid,
 FOREIGN KEY (default_model_id,user_id) REFERENCES models(id,user_id) ON DELETE SET NULL (default_model_id)
);
CREATE TABLE conversations (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (id,user_id)
);
CREATE INDEX conversations_user_updated_idx ON conversations(user_id,updated_at DESC,id);
CREATE TABLE messages (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 conversation_id uuid NOT NULL,
 ordinal bigint NOT NULL CHECK (ordinal >= 0),
 role text NOT NULL CHECK (role IN ('user','assistant')),
 content text NOT NULL DEFAULT '',
 status text NOT NULL CHECK (status IN ('pending','streaming','completed','failed','stopped')),
 created_at timestamptz NOT NULL DEFAULT now(),
 error_code text,
 error_message text,
 -- Historical model and generation identifiers deliberately have no FK:
 -- deleting configuration must preserve history and avoid circular ownership.
 model_id uuid,
 generation_id uuid,
 reasoning jsonb NOT NULL DEFAULT '{}'::jsonb,
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 FOREIGN KEY (conversation_id,user_id) REFERENCES conversations(id,user_id) ON DELETE CASCADE,
 UNIQUE (conversation_id,ordinal),
 UNIQUE (id,user_id,conversation_id)
);
CREATE TABLE generations (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 conversation_id uuid NOT NULL,
 assistant_message_id uuid,
 status text NOT NULL CHECK (status IN ('pending','streaming','completed','failed','stopped','cancelled')),
 snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (conversation_id,user_id) REFERENCES conversations(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY (assistant_message_id,user_id,conversation_id) REFERENCES messages(id,user_id,conversation_id) ON DELETE CASCADE,
 CHECK (status = 'cancelled' OR assistant_message_id IS NOT NULL)
);
CREATE UNIQUE INDEX generations_active_conversation_idx ON generations(conversation_id) WHERE status IN ('pending','streaming');
CREATE INDEX generations_conversation_idx ON generations(conversation_id,created_at);

-- +goose Down
DROP TABLE generations;
DROP TABLE messages;
DROP TABLE conversations;
DROP TABLE preferences;
DROP TABLE models;
DROP TABLE providers;
DROP TABLE sessions;
DROP TABLE users;
