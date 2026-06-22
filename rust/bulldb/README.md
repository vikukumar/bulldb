# BullDB for Rust

> **One Model. Every Database. Unified Security, AI, and High-Performance for Rust.**

BullDB is the world's most advanced cross-language ORM/ODM/Data Access Framework. This is the official Rust crate `bulldb`.

With BullDB, you define a single Active Record model struct and query it seamlessly across relational SQL engines (PostgreSQL, SQLite), document stores (MongoDB), key-value stores (Redis), and vector/graph databases under a unified schema-driven interface.

---

## Installation

Add the dependency to your `Cargo.toml`:

```toml
[dependencies]
bulldb = "1.0.0"
```

Or run:

```bash
cargo add bulldb
```

---

## Key Features

1. **Model Trait Implementation**: Standard Rust structs implementing the `Model` trait.
2. **Auto-Migrations**: Transparent schema diffing and table modification/reconstruction.
3. **Zero-Dependency Field Encryption**: Advanced AES-256-GCM secure field encryption with runtime key override (`security::set_encryption_key`) and secure random fallbacks.
4. **Cross-Language Compatibility**: Standardized binary payload layout (`nonce (12b) + tag (16b) + ciphertext`) allowing decryption across Python, TypeScript, Go, Rust, and C#.
5. **RAG Pipeline & Embeddings**: Built-in HTTP clients for OpenAI, Gemini, and Ollama embeddings.
6. **Performance Cache**: Transparent local TTL caching and telemetry/observability engines.

---

## Quick Start Example

Here is a complete, ready-to-run Rust example:

```rust
use std::collections::HashMap;
use bulldb::{Model, Value, FieldMetadata, MultiDatabase, QueryBuilder, MigrationEngine, security};

// 1. Define your model struct
struct User {
    id: String,
    email: String,
    secret_note: String,
    password: String,
}

// 2. Implement the Model trait
impl Model for User {
    fn table_name() -> &'static str { "users" }

    fn fields_metadata() -> Vec<FieldMetadata> {
        vec![
            FieldMetadata { name: "id".to_string(), datatype: "TEXT".to_string(), primary_key: true, unique: true, index: true },
            FieldMetadata { name: "email".to_string(), datatype: "TEXT".to_string(), primary_key: false, unique: true, index: true },
            FieldMetadata { name: "secret_note".to_string(), datatype: "BLOB".to_string(), primary_key: false, unique: false, index: false },
            FieldMetadata { name: "password".to_string(), datatype: "TEXT".to_string(), primary_key: false, unique: false, index: false },
        ]
    }

    fn to_map(&self) -> HashMap<String, Value> {
        let mut m = HashMap::new();
        m.insert("id".to_string(), Value::Text(self.id.clone()));
        m.insert("email".to_string(), Value::Text(self.email.clone()));
        // Auto-encrypt secret_note
        m.insert("secret_note".to_string(), Value::Blob(bulldb::encrypt_string(&self.secret_note).into_bytes()));
        // Auto-hash password
        m.insert("password".to_string(), Value::Text(bulldb::hash_string(&self.password)));
        m
    }

    fn from_map(mut map: HashMap<String, Value>) -> Self {
        let id = match map.remove("id").unwrap_or(Value::Null) { Value::Text(s) => s, _ => "".to_string() };
        let email = match map.remove("email").unwrap_or(Value::Null) { Value::Text(s) => s, _ => "".to_string() };
        let secret_note = match map.remove("secret_note").unwrap_or(Value::Null) {
            Value::Blob(b) => {
                let s_hex = String::from_utf8(b).unwrap_or_default();
                bulldb::decrypt_string(&s_hex).unwrap_or_default()
            },
            _ => "".to_string(),
        };
        let password = match map.remove("password").unwrap_or(Value::Null) { Value::Text(s) => s, _ => "".to_string() };
        User { id, email, secret_note, password }
    }
}

fn main() {
    // 3. Setup Multi-Engine Database Connection
    let mdb = MultiDatabase::new();
    
    // 4. Initialize and run schema migrations
    let mut mig = MigrationEngine::new(&mdb);
    mig.register_model::<User>();
    mig.generate_and_apply_schema::<User>().unwrap();

    // 5. Optional: Override default encryption key at runtime
    // (Default: uses BULLDB_ENCRYPTION_KEY env, or generates a secure random session key)
    security::set_encryption_key(b"my-custom-super-secret-key-32b-length".to_vec());

    // 6. Instantiate a new User
    let user = User {
        id: "12345678-1234-1234-1234-1234567890ab".to_string(),
        email: "developer@example.com".to_string(),
        secret_note: "This is highly confidential Rust data.".to_string(),
        password: "mySecurePassword123".to_string(),
    };

    // Save user via ActiveRecord save method
    let saved = user.save(&mdb).unwrap();
    println!("Saved User ID: {}", saved.id);

    // 7. Query User using QueryBuilder
    let qb = QueryBuilder::<User>::new(&mdb);
    let results = qb.r#where("email", "=", Value::Text("developer@example.com".to_string()))
                    .limit(1)
                    .execute()
                    .unwrap();

    if !results.is_empty() {
        println!("Decrypted Secret Note: {}", results[0].secret_note);
        
        // Verify Password hashing
        let raw_payload = results[0].to_map();
        let hashed_password = match raw_payload.get("password").unwrap() {
            Value::Text(s) => s,
            _ => panic!("Expected text"),
        };
        assert!(security::verify_password("mySecurePassword123", hashed_password));
        println!("Password matches!");
    }
}
```

---

## AI Embeddings & RAG Pipelines

Rust includes a built-in similarity search pipeline:

```rust
use bulldb::ai::RAGPipeline;

let pipeline = RAGPipeline::<Document>::new(&mdb, "vector_val", "text");
// Ingest text content
let doc_id = pipeline.ingest_document("High performance database client in Rust.", HashMap::new()).unwrap();

// Query similarity
let results = pipeline.query_similarity("database client", 1).unwrap();
println!("Similarity Match: {}", results[0].text);
```

---

## License

This package is licensed under the [MIT License](LICENSE.md).
