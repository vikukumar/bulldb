package bulldb

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type TestUser struct {
	ID         string `db:"id,primary_key"`
	Email      string `db:"email,unique"`
	SecretNote string `db:"secret_note" encrypt:"true"`
	Password   string `db:"password" hash:"true"`
}

func TestGoActiveRecordFlow(t *testing.T) {
	ctx := context.Background()

	// Initialize DB
	db := DB
	err := db.ConnectAll(ctx)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer db.DisconnectAll(ctx)

	// Migration
	mig := NewMigrationEngine()
	mig.RegisterModel(TestUser{})
	err = mig.GenerateAndApplySchema(ctx)
	if err != nil {
		t.Fatalf("failed migration: %v", err)
	}

	// Create
	user := TestUser{
		Email:      "test_go@example.com",
		SecretNote: "Top Secret Go Note",
		Password:   "mySecurePasswordGo",
	}
	err = Create(ctx, &user)
	if err != nil {
		t.Fatalf("failed to create: %v", err)
	}

	if user.ID == "" {
		t.Fatalf("expected generated ID")
	}

	// Verify encryption & hashing in DB payload
	payload, err := MapStructToMap(user)
	if err != nil {
		t.Fatalf("map failed: %v", err)
	}
	if payload["secret_note"] == "Top Secret Go Note" {
		t.Errorf("secret note not encrypted: %v", payload["secret_note"])
	}
	if payload["password"] == "mySecurePasswordGo" {
		t.Errorf("password not hashed: %v", payload["password"])
	}

	// GetById
	var fetched TestUser
	err = GetById(ctx, user.ID, &fetched)
	if err != nil {
		t.Fatalf("GetById failed: %v", err)
	}
	if fetched.Email != "test_go@example.com" {
		t.Errorf("expected test_go@example.com, got %s", fetched.Email)
	}
	if fetched.SecretNote != "Top Secret Go Note" {
		t.Errorf("failed decryption, got %s", fetched.SecretNote)
	}

	// FindFirst
	var first TestUser
	err = FindFirst(ctx, map[string]interface{}{"email": "test_go@example.com"}, &first)
	if err != nil {
		t.Fatalf("FindFirst failed: %v", err)
	}
	if first.ID != user.ID {
		t.Errorf("expected matching ID")
	}

	// Count
	cnt, err := Count(ctx, "testusers", map[string]interface{}{"email": "test_go@example.com"})
	if err != nil {
		t.Fatalf("Count failed: %v", err)
	}
	if cnt != 1 {
		t.Errorf("expected count to be 1, got %d", cnt)
	}

	// Reload
	user.Email = "modified@example.com"
	err = Reload(ctx, &user)
	if err != nil {
		t.Fatalf("Reload failed: %v", err)
	}
	if user.Email != "test_go@example.com" {
		t.Errorf("expected reloaded email to be test_go@example.com, got %s", user.Email)
	}

	// ToJSON
	jsonMap, err := ToJSON(user)
	if err != nil {
		t.Fatalf("ToJSON failed: %v", err)
	}
	if jsonMap["secret_note"] != "Top Secret Go Note" {
		t.Errorf("ToJSON failed decryption")
	}

	// Verify password
	if !VerifyPassword("mySecurePasswordGo", fetched.Password) {
		t.Errorf("password verification failed")
	}

	// Delete
	err = Delete(ctx, &user)
	if err != nil {
		t.Fatalf("Delete failed: %v", err)
	}

	cntAfter, err := Count(ctx, "testusers", map[string]interface{}{})
	if err != nil {
		t.Fatalf("count failed: %v", err)
	}
	if cntAfter != 0 {
		t.Errorf("expected count 0, got %d", cntAfter)
	}
}

func TestGoReverseEngineeringGenerator(t *testing.T) {
	ctx := context.Background()
	db := DB
	_ = db.ConnectAll(ctx)
	defer db.DisconnectAll(ctx)

	mig := NewMigrationEngine()
	mig.RegisterModel(TestUser{})
	_ = mig.GenerateAndApplySchema(ctx)

	tmpDir, err := os.MkdirTemp("", "bulldb-go-")
	if err != nil {
		t.Fatalf("failed temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	outPath := filepath.Join(tmpDir, "generated.go")
	err = ModelGenerator{}.ReverseEngineer(ctx, db, outPath)
	if err != nil {
		t.Fatalf("failed generator: %v", err)
	}

	content, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatalf("failed read file: %v", err)
	}

	contentStr := string(content)
	if !strings.Contains(contentStr, "package main") {
		t.Errorf("missing package main")
	}
	if !strings.Contains(contentStr, "type Testuser struct") {
		t.Errorf("missing Testuser definition")
	}
}

func TestGoRAGPipeline(t *testing.T) {
	ctx := context.Background()
	db := DB
	_ = db.ConnectAll(ctx)
	defer db.DisconnectAll(ctx)

	type Document struct {
		ID        string    `db:"id,primary_key"`
		Text      string    `db:"text"`
		VectorVal []float64 `db:"vector_val"`
	}

	mig := NewMigrationEngine()
	mig.RegisterModel(Document{})
	_ = mig.GenerateAndApplySchema(ctx)

	pipeline := NewRAGPipeline(Document{}, "vector_val", "text")
	inserted, err := pipeline.IngestDocument(ctx, "This is a machine learning document discussing embeddings.", nil)
	if err != nil {
		t.Fatalf("failed ingest: %v", err)
	}
	if len(inserted) == 0 {
		t.Errorf("expected documents ingested")
	}

	var results []Document
	err = pipeline.QuerySimilarity(ctx, "embeddings", 1, &results)
	if err != nil {
		t.Fatalf("similarity query failed: %v", err)
	}
	if len(results) == 0 {
		t.Errorf("expected similar documents")
	}
}

func TestGoPerformanceCacheAndTelemetry(t *testing.T) {
	// Cache
	cache := GlobalCache
	cache.Set("my_key", "my_val", 1*time.Second)
	val, exists := cache.Get("my_key")
	if !exists || val != "my_val" {
		t.Errorf("failed cache check")
	}

	time.Sleep(1100 * time.Millisecond)
	_, expired := cache.Get("my_key")
	if expired {
		t.Errorf("cache did not expire")
	}

	// Telemetry
	telemetry.IncrementMetric("cache_hit")
	if telemetry.GetMetric("cache_hit") != 1 {
		t.Errorf("telemetry increment failed")
	}
}
