# BullDB
> **One Model. Every Database. Unified Security, AI, and High-Performance Across 5 Languages.**

[![NPM Version](https://img.shields.io/npm/v/@vikukumar/bulldb.svg?logo=npm&logoColor=white)](https://www.npmjs.com/package/@vikukumar/bulldb)
[![PyPI Version](https://img.shields.io/pypi/v/bulldb.svg?logo=python&logoColor=white)](https://pypi.org/project/bulldb/)
[![NuGet Version](https://img.shields.io/nuget/v/BullDB.svg?logo=nuget&logoColor=white)](https://www.nuget.org/packages/BullDB/)
[![Crates.io Version](https://img.shields.io/crates/v/bulldb.svg?logo=rust&logoColor=white)](https://crates.io/crates/bulldb)
[![Go Reference](https://img.shields.io/badge/go-reference-00ADD8?logo=go&logoColor=white)](https://pkg.go.dev/github.com/vikukumar/bulldb@v1.0.15)

BullDB is the world's most advanced cross-language ORM/ODM/Data Access Framework. It enables you to define a single model definition and query it across relational SQL engines (PostgreSQL, SQLite), document stores (MongoDB), key-value stores (Redis), vector engines, graph nodes, and search nodes under a single unified schema-driven active record layer. 

Supported languages: **Python**, **TypeScript (Node.js)**, **Go**, **Rust**, and **C# (.NET)**.

---

## Key Features

1. **True Multi-Engine & Multi-Language Parity**: Consistent active record model definitions and syntax engines across Python, TypeScript, Go, Rust, and C#.
2. **Secure-by-Default Field Encryption**: Zero-dependency AES-256-GCM field encryption.
   - **Cross-Language Binary Compatible**: Uses a standardized `nonce (12b) + tag (16b) + ciphertext` layout so files or fields encrypted in one language can be decrypted by any other.
   - **Dynamic Key Overrides**: Call `SetEncryptionKey` at runtime to change keys on the fly.
   - **Secure-by-Default Fallback**: If no environment variable `BULLDB_ENCRYPTION_KEY` is provided, BullDB generates a cryptographically secure random key, caches it thread-safely in-memory, and avoids compile-time static strings.
3. **Real HTTP AI Embeddings**: Fully implemented HTTP clients for OpenAI, Gemini, and Ollama APIs across all supported languages (with transparent local caching).
4. **Auto-Migrations**: Fully automated DDL schema synchronization. Adds, removes, updates, and indexing columns or properties based on code model evolution.
5. **Centralized Version Sync**: Simple single-point-of-truth version management using `version.json` at the root.

---

## Repository Structure

```
.
├── .github/workflows/   # CI/CD workflows
│   ├── ci.yml           # Continuous Integration (build & test)
│   └── publish.yml      # Release workflow (npm, pypi, nuget, crates.io, git tags)
├── version.json         # Unified version single-source-of-truth
├── sync_versions.py     # Version sync propagation script
├── python/              # Python ORM Package
├── typescript/          # TypeScript Node ORM Package
├── golang/              # Go database interface module
├── rust/                # Rust high-performance crate
└── csharp/              # C# (.NET Core) high-performance library
```

---

## Centralized Version Management

We maintain a single unified version across all packages in the repository root:

1. Edit [version.json](file:///d:/Projects/BullDB/version.json):
   ```json
   {
     "version": "1.0.0"
   }
   ```
2. Propagate to all subprojects by running the sync tool:
   ```bash
   python sync_versions.py
   ```
   This propagates the version to `pyproject.toml`, `package.json`, `Cargo.toml`, `BullDB.csproj`, and Go's `version.go` constants.

---

## Field Encryption & Key Override

### Secure-by-Default Key Hierarchy
1. Explicit runtime override: Call `SetEncryptionKey` passing key bytes.
2. Environment-derived key: Uses `BULLDB_ENCRYPTION_KEY` environment variable.
3. Secure Fallback: Thread-safe, secure random key generated and cached for the session (no static compile-time strings).

### Code Examples

#### Python
```python
from bulldb.security import SecurityEngine

# Runtime key override (must be 32 bytes or padded automatically)
SecurityEngine.set_encryption_key(b"my-custom-super-secret-key-32b-length")
```

#### TypeScript
```typescript
import { SecurityEngine } from "@vikukumar/bulldb";

// Runtime key override
SecurityEngine.setEncryptionKey(Buffer.from("my-custom-super-secret-key-32b-length"));
```

#### Go
```go
import "github.com/vikukumar/bulldb/golang/bulldb"

// Runtime key override
bulldb.SetEncryptionKey([]byte("my-custom-super-secret-key-32b-length"))
```

#### Rust
```rust
use bulldb::security;

// Runtime key override
security::set_encryption_key(b"my-custom-super-secret-key-32b-length".to_vector());
```

#### C#
```csharp
using BullDB;

// Runtime key override
SecurityEngine.SetEncryptionKey(Encoding.UTF8.GetBytes("my-custom-super-secret-key-32b-length"));
```

---

## Real AI Embeddings & RAG Pipelines

BullDB implements native embedding requests to OpenAI, Gemini, and Ollama. When a model's text field is written, it generates the vectors using the selected provider, caches them local-first to prevent redundant API charges, and saves them into the vector database.

- **OpenAI Endpoint**: `https://api.openai.com/v1/embeddings` (using `text-embedding-3-small` by default)
- **Gemini Endpoint**: `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent`
- **Ollama Endpoint**: `{OLLAMA_URL}/api/embeddings` (using `nomic-embed-text` by default)

---

## CI/CD Package Manager Publication

A production-grade CI/CD release workflow is configured in [.github/workflows/publish.yml](file:///d:/Projects/BullDB/.github/workflows/publish.yml).

### Publication Destinations
- **TypeScript**: Pushed to **NPM** using `npm publish` with access set to public.
- **Python**: Built using Python build and uploaded to **PyPI** via `twine`.
- **C#**: Packaged via `dotnet pack` and pushed to **NuGet**.
- **Rust**: Released to **Crates.io** using `cargo publish`.
- **Go**: Tagged using the format `golang/vX.Y.Z` and pushed to origin, enabling versioned Go module importing.

### Prerequisites (GitHub Repository Secrets)
To enable the pipeline, configure the following secrets on GitHub:
- `NPM_TOKEN` (NPM Access token)
- `PYPI_API_TOKEN` (PyPI token prefixed with `pypi-`)
- `NUGET_API_KEY` (NuGet API push token)
- `CARGO_REGISTRY_TOKEN` (Crates.io token)
- `PERSONAL_ACCESS_TOKEN` (Git PAT with write permission to create module tags)

---

## Local Verification & Development

To test the package locally in each subfolder:

- **Python**: `cd python && python -m pytest`
- **TypeScript**: `cd typescript && npm test`
- **Go**: `cd golang && go test ./...`
- **Rust**: `cd rust/bulldb && cargo test`
- **C#**: `cd csharp/BullDB.Tests && dotnet test`
