# BullDB Mermaid Diagrams

This document contains visual diagrams mapping out BullDB's systems, code structures, data flows, and deployments.

---

## 1. C4 Container Diagram

```mermaid
graph TD
    User([User App / Developer]) -->|Imports / API Calls| BullDB[BullDB Framework]
    
    subgraph BullDB Framework
        ModelAPI[Universal Model API] --> SchemaReg[Schema Registry]
        DBRouter[MultiDatabase Router] --> PoolMgr[Connection Pool Manager]
        QueryBld[Query Builder] --> ASTComp[AST Compiler]
        SecEng[Security Engine] --> RLS[RLS & Encryption]
        AIEng[AI Engine] --> EmbedPipe[Embedding Pipelines]
        PerfEng[Performance Engine] --> QCache[Query Cache]
    end

    PoolMgr -->|SQL Commands| RDBMS[(PostgreSQL / MySQL / SQLite)]
    PoolMgr -->|NoSQL Commands| NoSQL[(MongoDB / DynamoDB)]
    PoolMgr -->|Cypher Queries| Graph[(Neo4j)]
    PoolMgr -->|Embeddings / Vectors| Vector[(pgvector / Pinecone)]
    PoolMgr -->|Search Queries| Search[(Elasticsearch / Meilisearch)]
```

---

## 2. Component Class Diagram

```mermaid
classDiagram
    class BaseModel {
        +schema : Object
        +save() Promise
        +delete() Promise
        +find(filter) QueryBuilder
    }
    class MultiDatabase {
        +pools : Map
        +router : DatabaseRouter
        +register(name, url)
        +execute(query)
    }
    class QueryBuilder {
        +ast : QueryAST
        +select(fields)
        +where(conditions)
        +join(relation)
        +compile(dialect)
    }
    class QueryAST {
        +nodes : List~ASTNode~
        +toSQL()
        +toMongo()
    }
    class SecurityEngine {
        +sanitize(query)
        +encryptField(value, key)
        +decryptField(value, key)
        +injectRLS(ast, context)
    }
    class AIEngine {
        +generateEmbeddings(text)
        +hybridSearch(vector, filter)
    }

    BaseModel --> QueryBuilder
    MultiDatabase --> QueryBuilder
    QueryBuilder --> QueryAST
    QueryBuilder --> SecurityEngine
    QueryBuilder --> AIEngine
```

---

## 3. ER Diagram (Federated Schema Example)

```mermaid
erDiagram
    USER {
        uuid id PK
        string email UK
        string username
        int age
        string password_hash
    }
    TENANT {
        uuid id PK
        string name
        string plan
    }
    DOCUMENT {
        uuid id PK
        uuid tenant_id FK
        string title
        string text_content
        vector embedding
    }
    USER ||--o{ DOCUMENT : "creates"
    TENANT ||--o{ DOCUMENT : "owns"
    TENANT ||--o{ USER : "has"
```

---

## 4. Sequence Diagram: Data Write and Auto-Embedding Flow

```mermaid
sequenceDiagram
    autonumber
    actor Developer
    participant Model as BaseModel
    participant Security as SecurityEngine
    participant AI as AIEngine
    participant DB as MultiDatabase
    participant Target as VectorDB / RDBMS

    Developer->>Model: user.save()
    Model->>Security: encryptField(secrets)
    Security-->>Model: encrypted value
    Model->>AI: generateEmbeddings(documentText)
    AI-->>Model: returns float[] vector
    Model->>DB: executeInsert(AST)
    DB->>Target: Parameterized Query / Vector Insert
    Target-->>DB: Success
    DB-->>Model: Return Record
    Model-->>Developer: Return Saved Entity
```

---

## 5. Deployment Topology

```mermaid
graph TD
    Client[App Container] -->|Write Operations| PrimaryDB[(PostgreSQL Primary)]
    Client -->|Read Queries| ReplicaDB[(PostgreSQL Replica)]
    Client -->|Vector Search| VecDB[(pgvector / Qdrant)]
    Client -->|Text Search| SearchDB[(Meilisearch / OpenSearch)]
    Client -->|Distributed Cache| RedisDB[(Redis Cluster)]

    PrimaryDB -->|Asynchronous Replication| ReplicaDB
```
