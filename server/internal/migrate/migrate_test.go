package migrate

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"testing"
	"time"

	"closewebui/server/internal/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/joho/godotenv"
)

func isolatedDatabase(t *testing.T) (context.Context, *sql.DB, *pgx.Conn) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		values, _ := godotenv.Read("../../../.env.backend.local")
		dsn = values["DATABASE_URL"]
	}
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL required for database integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	admin, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal("database connection failed")
	}
	schema := "test_migration_" + uuid.New().String()[:8]
	schemaSQL := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schemaSQL); err != nil {
		admin.Close(ctx)
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, c := context.WithTimeout(context.Background(), 10*time.Second)
		defer c()
		admin.Exec(cleanupCtx, "DROP SCHEMA "+schemaSQL+" CASCADE")
		admin.Close(cleanupCtx)
	})
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal("invalid database configuration")
	}
	config.RuntimeParams["search_path"] = schema
	sqlDB := stdlib.OpenDB(*config)
	t.Cleanup(func() { sqlDB.Close() })
	conn, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		t.Fatal("test schema connection failed")
	}
	t.Cleanup(func() { conn.Close(context.Background()) })
	return ctx, sqlDB, conn
}

func assertConstraint(t *testing.T, err error, code string) {
	t.Helper()
	var pg *pgconn.PgError
	if !errors.As(err, &pg) || pg.Code != code {
		t.Fatalf("wanted PostgreSQL constraint %s, got %v", code, err)
	}
}

func TestMigrationOwnershipCancellationAndRollback(t *testing.T) {
	ctx, sqlDB, conn := isolatedDatabase(t)
	if err := Up(ctx, sqlDB); err != nil {
		t.Fatal(err)
	}
	if err := Up(ctx, sqlDB); err != nil {
		t.Fatalf("migration not idempotent: %v", err)
	}
	queries := db.New(conn)
	first := uuid.NewString()
	second := uuid.NewString()
	provider := uuid.NewString()
	model := uuid.NewString()
	conversation := uuid.NewString()
	message := uuid.NewString()
	for _, user := range []string{first, second} {
		if _, err := queries.CreateUser(ctx, db.CreateUserParams{ID: user, Username: user, PasswordHash: "test-hash"}); err != nil {
			t.Fatal(err)
		}
	}
	_, err := queries.CreateProvider(ctx, db.CreateProviderParams{ID: provider, UserID: first, Name: "fictional", TemplateID: "custom", Protocol: "openai-chat", Adapter: "standard", BaseUrl: "https://example.com", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	create := db.CreateModelParams{ID: model, UserID: second, ProviderID: provider, ModelID: "fictional", Name: "fictional", MaxOutputTokens: 1024, DefaultReasoning: []byte("{}")}
	_, err = queries.CreateModel(ctx, create)
	assertConstraint(t, err, "23503")
	create.UserID = first
	if _, err = queries.CreateModel(ctx, create); err != nil {
		t.Fatal(err)
	}
	_, err = queries.UpsertPreferences(ctx, db.UpsertPreferencesParams{UserID: second, DefaultModelID: &model})
	assertConstraint(t, err, "23503")
	if _, err = queries.UpsertPreferences(ctx, db.UpsertPreferencesParams{UserID: first, DefaultModelID: &model}); err != nil {
		t.Fatal(err)
	}
	if _, err = queries.CreateConversation(ctx, db.CreateConversationParams{ID: conversation, UserID: first, Title: "fictional history"}); err != nil {
		t.Fatal(err)
	}
	_, err = conn.Exec(ctx, "INSERT INTO messages(id,user_id,conversation_id,ordinal,role,status) VALUES($1,$2,$3,0,'assistant','pending')", message, second, conversation)
	assertConstraint(t, err, "23503")
	_, err = conn.Exec(ctx, "INSERT INTO messages(id,user_id,conversation_id,ordinal,role,status,model_id) VALUES($1,$2,$3,0,'assistant','pending',$4)", message, first, conversation, model)
	if err != nil {
		t.Fatal(err)
	}
	_, err = conn.Exec(ctx, "INSERT INTO generations(id,user_id,conversation_id,status) VALUES($1,$2,$3,'cancelled')", uuid.NewString(), first, conversation)
	if err != nil {
		t.Fatalf("early cancellation failed: %v", err)
	}
	_, err = conn.Exec(ctx, "INSERT INTO generations(id,user_id,conversation_id,assistant_message_id,status) VALUES($1,$2,$3,$4,'pending')", uuid.NewString(), first, conversation, message)
	if err != nil {
		t.Fatal(err)
	}
	_, err = conn.Exec(ctx, "INSERT INTO generations(id,user_id,conversation_id,assistant_message_id,status) VALUES($1,$2,$3,$4,'streaming')", uuid.NewString(), first, conversation, message)
	assertConstraint(t, err, "23505")
	if _, err = queries.GetConversation(ctx, db.GetConversationParams{ID: conversation, UserID: second}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal("query exposed another user's conversation")
	}
	if _, err = queries.DeleteModel(ctx, db.DeleteModelParams{ID: model, UserID: first}); err != nil {
		t.Fatal(err)
	}
	preference, err := queries.GetPreferences(ctx, first)
	if err != nil || preference.UserID != first || preference.DefaultModelID != nil {
		t.Fatalf("model deletion did not preserve cleared preference: %v", err)
	}
	messages, err := queries.ListMessages(ctx, db.ListMessagesParams{ConversationID: conversation, UserID: first})
	if err != nil || len(messages) != 1 || messages[0].ModelID == nil || *messages[0].ModelID != model {
		t.Fatal("model deletion lost history")
	}
	if _, err = queries.DeleteConversation(ctx, db.DeleteConversationParams{ID: conversation, UserID: first}); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = conn.QueryRow(ctx, "SELECT count(*) FROM generations WHERE conversation_id=$1", conversation).Scan(&count); err != nil || count != 0 {
		t.Fatal("conversation deletion did not cascade generations")
	}
	messages, err = queries.ListMessages(ctx, db.ListMessagesParams{ConversationID: conversation, UserID: first})
	if err != nil || len(messages) != 0 {
		t.Fatal("conversation deletion did not cascade messages")
	}
	if err = Down(ctx, sqlDB); err != nil {
		t.Fatal(err)
	}
	var table *string
	if err = conn.QueryRow(ctx, "SELECT to_regclass('users')::text").Scan(&table); err != nil || table != nil {
		t.Fatal("rollback left users table")
	}
}
