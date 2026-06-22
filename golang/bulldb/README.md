# BullDB Go Package

> **One Model. Every Database. Unified Security, AI, and High-Performance for Go.**

This package is part of BullDB: the world's most advanced cross-language ORM/ODM/Data Access Framework.

Refer to the main module [README](../README.md) for full installation instructions, key features, and semantic search (RAG) details.

---

## Quick Start Example

```go
package main

import (
	"context"
	"fmt"
	"github.com/vikukumar/bulldb/golang/bulldb"
)

// Define your model struct with db, encrypt, and hash tags
type User struct {
	ID         string `db:"id,primary_key"`
	Email      string `db:"email,unique"`
	SecretNote string `db:"secret_note" encrypt:"true"`
	Password   string `db:"password" hash:"true"`
}

func main() {
	ctx := context.Background()

	// Setup Connection
	db := bulldb.DB
	err := db.ConnectAll(ctx)
	if err != nil {
		panic(err)
	}
	defer db.DisconnectAll(ctx)

	// Migration
	mig := bulldb.NewMigrationEngine()
	mig.RegisterModel(User{})
	err = mig.GenerateAndApplySchema(ctx)
	if err != nil {
		panic(err)
	}

	// Create and save
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
}
```

---

## License

This package is licensed under the [MIT License](../LICENSE.md).
