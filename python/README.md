# BullDB for Python

> **One Model. Every Database. Unified Security, AI, and High-Performance for Python.**

BullDB is the world's most advanced cross-language ORM/ODM/Data Access Framework. This is the official Python package.

With BullDB, you define a single Active Record model class and query it seamlessly across relational SQL engines (PostgreSQL, SQLite), document stores (MongoDB), key-value stores (Redis), and vector/graph databases under a unified schema-driven interface.

---

## Installation

Install the package via `pip`:

```bash
pip install bulldb
```

Ensure you have your environment database configs set, or use the default SQLite in-memory pool for quick starts.

---

## Key Features

1. **Active Record Models**: Native Python classes inheriting from `BaseModel` with clean type annotations.
2. **Auto-Migrations**: Transparent schema diffing and table modification/reconstruction.
3. **Zero-Dependency Field Encryption**: Advanced AES-256-GCM secure field encryption with runtime key override (`set_encryption_key`) and secure random fallbacks.
4. **Cross-Language Compatibility**: Standardized binary payload layout (`nonce (12b) + tag (16b) + ciphertext`) allowing decryption across Python, TypeScript, Go, Rust, and C#.
5. **Native AI Embeddings**: Built-in HTTP clients for OpenAI, Gemini, and Ollama embeddings.
6. **Performance Cache**: Transparent local TTL caching and telemetry/observability engines.

---

## Quick Start Example

Here is a complete, ready-to-run Python example:

```python
import asyncio
from bulldb import BaseModel, PrimaryKey, Unique, MultiDatabase, UUID, Email, EncryptedString, HashedPassword
from bulldb.migration import MigrationEngine
from bulldb.security import SecurityEngine

# 1. Define your Active Record model
class User(BaseModel):
    id: UUID = PrimaryKey()
    email: Email = Unique()
    secret_note: str = EncryptedString()
    password: str = HashedPassword()

async def main():
    # 2. Setup Multi-Engine Database Connection
    db = MultiDatabase()
    await db.connect_all()
    BaseModel.set_db(db)
    
    # 3. Initialize and run schema migrations
    migrator = MigrationEngine(db)
    migrator.register_model(User)
    await migrator.generate_and_apply_schema()

    # 4. Optional: Override the default encryption key at runtime
    # (Default: uses BULLDB_ENCRYPTION_KEY env, or generates a secure random session key)
    SecurityEngine.set_encryption_key(b"my-custom-super-secret-key-32b-length")

    # 5. Create and save a user
    user = await User.create(
        email="developer@example.com",
        secret_note="This is highly confidential Python data.",
        password="mySecurePassword123"
    )
    print(f"Created User ID: {user.id}")
    
    # Note: Secret note is encrypted, and password is salted and hashed in the database!
    print(f"Encrypted Password in DB: {user.password}")

    # 6. Retrieve the user
    # Fetch by ID (automatic decryption of encrypted fields on load)
    fetched = await User.get_by_id(user.id)
    print(f"Decrypted Secret Note: {fetched.secret_note}")  # "This is highly confidential Python data."

    # Find first record matching conditions
    first_user = await User.find_first(email="developer@example.com")
    print(f"Found User ID: {first_user.id}")

    # 7. Password verification
    is_valid = SecurityEngine.verify_password("mySecurePassword123", fetched.password)
    print(f"Password Valid: {is_valid}")  # True

    # 8. Clean up / delete user
    await user.delete()
    print("User deleted successfully.")
    
    await db.disconnect_all()

if __name__ == "__main__":
    asyncio.run(main())
```

---

## AI Embeddings & RAG Pipelines

Instantiate a RAG pipeline on your document models:

```python
from bulldb.ai import RAGPipeline

# Define a Document model
class Document(BaseModel):
    id: UUID = PrimaryKey()
    text: str
    vector_val: list  # Stored embeddings

# Set up and ingest a document
pipeline = RAGPipeline(Document, vector_field="vector_val", text_field="text")
await pipeline.ingest_document("BullDB makes multi-language database access a breeze.")

# Query semantic similarity
results = await pipeline.query_similarity("multi-language database", limit=1)
for doc in results:
    print(f"Similarity Match: {doc.text}")
```

---

## License

This package is licensed under the [MIT License](LICENSE.md).
