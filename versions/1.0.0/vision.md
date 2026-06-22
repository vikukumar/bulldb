# BullDB: One Model. Every Database.

## Vision Document & Product Requirements

BullDB represents a paradigm shift in modern application development. By unifying SQL, NoSQL, Vector, Graph, and Search databases behind a single, cohesive, universal programming interface, it removes database-specific lock-in, eliminates duplicate boilerplate, and optimizes resource utilization across heterogeneous storage engines.

---

## 1. Product Requirements

### 1.1 Universal Model Definition
Developers specify schemas once using native language constructs:
- **Python**: Models subclass `BaseModel` and declare fields as type-annotated descriptors.
- **TypeScript**: Models subclass `BaseModel` and utilize property decorators (`@PrimaryKey()`, `@Unique()`, etc.).
The framework automatically parses these declarations, matches them with corresponding target engines, and generates required runtime schemas.

### 1.2 Multi-Database Federation & Routing
A single interface (`MultiDatabase`) orchestrates connections across distinct storage layers.
- **Auto-Discovery**: Resolves environment configurations (`DATABASE_URL`, `POSTGRES_URL`, `MONGO_URL`, `SQLITE_URL`).
- **Read/Write Splitting**: Automatically sends mutation operations (`insert`, `update`, `delete`) to write primaries and query operations (`select`, `find`) to read replicas.
- **Circuit Breaking & Retries**: Guards query routing with automatic exponential backoff retries and open/close state circuit breakers.
- **Cross-Database Transactions**: Coordinates distributed operations with two-phase commit capabilities where supported, or structured rollbacks.

### 1.3 Universal Datatypes Mapping
Provides complete mapping from universal data structures (`UUID`, `ULID`, `Email`, `Phone`, `URL`, `IPAddress`, `JSON`, `JSONB`, `Array`, `Enum`, `Money`, `Decimal`, `TimestampTZ`, `EncryptedString`, `HashedPassword`, `Secret`, `Binary`, `GeoPoint`, `Polygon`, `Vector`, `Embedding`, `Document`, `ImageEmbedding`, `AudioEmbedding`, `VideoEmbedding`) to target SQL/NoSQL storage structures.
- Client-side encryption is automatically applied to `EncryptedString` and `Secret` fields before transmission.
- Hashing (e.g., bcrypt/argon2) is applied to `HashedPassword` during mutation.

### 1.4 Vector & AI Co-processing
- Integrated embedding pipeline triggers automatically upon mutations.
- Enables hybrid search (combining SQL keyword filtering with Vector cosine similarity).
- Connects to providers (OpenAI, Gemini, Anthropic, Ollama) transparently.

### 1.5 Real-Time Observability
- Integration with OpenTelemetry for tracing queries.
- Prometheus counters for connection pool metrics, query latencies, cache ratios.
- Structured JSON logs with context propagation.
