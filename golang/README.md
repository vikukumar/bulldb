# BullDB for Go

> **One Model. Every Database. Unified Security, AI, and High-Performance for Go.**

BullDB is the world's most advanced cross-language ORM/ODM/Data Access Framework. This is the official Go module `bulldb`.

With BullDB, you define a single Active Record model struct and query it seamlessly across relational SQL engines (PostgreSQL, SQLite), document stores (MongoDB), key-value stores (Redis), and vector/graph databases under a unified schema-driven interface.

---

## Installation

Initialize your Go module (if not already done) and get the package:

```bash
go get github.com/vikukumar/bulldb/golang/bulldb
```

---

## Key Features

1. **Struct Tag Mappings**: Standard Go structs with `db` tags mapping names, primary keys, and uniques, alongside `encrypt` and `hash` keys.
2. **Auto-Migrations**: Transparent schema diffing and table modification/reconstruction.
3. **Zero-Dependency Field Encryption**: Advanced AES-256-GCM secure field encryption with runtime key override (`SetEncryptionKey`) and secure random fallbacks.
4. **Cross-Language Compatibility**: Standardized binary payload layout (`nonce (12b) + tag (16b) + ciphertext`) allowing decryption across Python, TypeScript, Go, Rust, and C#.
5. **Context-Aware API**: Fully context-supportive database operations.
6. **RAG Pipeline & Embeddings**: Seamless semantic search and integration.

---

## Quick Start Example

Here is a complete, ready-to-run Go example:

```go
package main

import (
	"context"
	"fmt"
	"github.com/vikukumar/bulldb/golang/bulldb"
)

// 1. Define your model struct with db, encrypt, and hash tags
type User struct {
	ID         string `db:"id,primary_key"`
	Email      string `db:"email,unique"`
	SecretNote string `db:"secret_note" encrypt:"true"`
	Password   string `db:"password" hash:"true"`
}

func main() {
	ctx := context.Background()

	// 2. Setup Multi-Engine Database Connection
	db := bulldb.DB
	err := db.ConnectAll(ctx)
	if err != nil {
		panic(err)
	}
	defer db.DisconnectAll(ctx)

	// 3. Initialize and run schema migrations
	mig := bulldb.NewMigrationEngine()
	mig.RegisterModel(User{})
	err = mig.GenerateAndApplySchema(ctx)
	if err != nil {
		panic(err)
	}

	// 4. Optional: Override default encryption key at runtime
	// (Default: uses BULLDB_ENCRYPTION_KEY env, or generates a secure random session key)
	bulldb.SetEncryptionKey([]byte("my-custom-super-secret-key-32b-length"))

	// 5. Create and save a user
	user := User{
		Email:      "developer@example.com",
		SecretNote: "This is highly confidential Go data.",
		Password:   "mySecurePassword123",
	}
	err = bulldb.Create(ctx, &user)
	if err != nil {
		panic(err)
	}
	fmt.Printf("Created User ID: %s\n", user.ID)

	// Note: SecretNote is encrypted and Password is salted + hashed in the database!
	// Let's verify password validation
	var fetched User
	err = bulldb.GetById(ctx, user.ID, &fetched)
	if err != nil {
		panic(err)
	}
	fmt.Printf("Decrypted Secret Note: %s\n", fetched.SecretNote) // "This is highly confidential Go data."

	// Verify password
	isValid := bulldb.VerifyPassword("mySecurePassword123", fetched.Password)
	fmt.Printf("Password Matches: %t\n", isValid) // true

	// 6. Find first record matching conditions
	var firstUser User
	err = bulldb.FindFirst(ctx, map[string]interface{}{"email": "developer@example.com"}, &firstUser)
	if err == nil {
		fmt.Printf("Found User ID: %s\n", firstUser.ID)
	}

	// 7. Clean up / delete user
	err = bulldb.Delete(ctx, &user)
	if err != nil {
		panic(err)
	}
	fmt.Println("User deleted successfully.")
}
```

---

## AI Embeddings & RAG Pipelines

Go includes a built-in semantic similarity pipeline:

```go
type Document struct {
	ID        string    `db:"id,primary_key"`
	Text      string    `db:"text"`
	VectorVal []float64 `db:"vector_val"`
}

pipeline := bulldb.NewRAGPipeline(Document{}, "vector_val", "text")
// Ingest text content
insertedIds, err := pipeline.IngestDocument(ctx, "High performance Go client for AI RAG.", nil)

// Query similarity
var results []Document
err = pipeline.QuerySimilarity(ctx, "AI RAG Go client", 1, &results)
if err == nil {
	fmt.Printf("Similarity Match: %s\n", results[0].Text)
}
```

---

## License

This package is licensed under the [MIT License](LICENSE.md).
