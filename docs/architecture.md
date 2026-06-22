# BullDB Architecture & Design Specifications

This document outlines the architectural blueprint, security postures, reliability metrics, and scalability decisions for BullDB.

---

## 1. Architectural Decision Records (ADRs)

### ADR 001: AST-Based Query Compiler
* **Context**: BullDB supports SQL, NoSQL (MongoDB/DynamoDB), Graph (Neo4j), Search (Elasticsearch), and Vector engines. Translating queries string-by-string results in fragile logic.
* **Decision**: We use an Abstract Syntax Tree (AST) query representation. The query builder builds a semantic tree of the query (filters, projection, joins, limits). Dialect-specific Compilers parse the AST and compile it into target query syntaxes (SQL, Mongo pipelines, Cypher, Vector JSON).
* **Consequences**: Easy addition of new databases; strong validation compile-time or build-time.

### ADR 002: Client-Side Crypto Envelope for Secrets
* **Context**: `EncryptedString` and `Secret` fields must not reach databases in plain text.
* **Decision**: Implement cryptographic envelope encryption inside the model lifecycle hooks. We use AES-256-GCM for encryption at rest before data reaches the driver. The encryption keys are fetched from an external KMS or environment-based master key.
* **Consequences**: Zero trust database storage; database administrators cannot view sensitive user fields.

### ADR 003: Hybrid Transaction Coordinator (2PC)
* **Context**: Transactions span SQL databases and NoSQL/Vector engines.
* **Decision**: Implement a best-effort transaction orchestrator with a Saga pattern / Two-Phase Commit interface.
* **Consequences**: Ensures cross-database operations are either committed on all ends or compensated via rollbacks.

---

## 2. High-Level Design (HLD)

```
       +---------------------------------------------+
       |             Client Application              |
       +---------------------------------------------+
                              |
       +---------------------------------------------+
       |             BullDB Universal API            |
       |  (BaseModel / MultiDatabase / QueryBuilder)  |
       +---------------------------------------------+
            /                 |                 \
  +------------------+ +--------------+ +------------------+
  | Security Engine  | |  AI Engine   | | Perf Optimizer   |
  | (RLS, RBAC, Enc) | | (Embed, RAG) | | (Pool, Cache, N+1)|
  +------------------+ +--------------+ +------------------+
            \                 |                 /
       +---------------------------------------------+
       |             Query AST Compiler              |
       +---------------------------------------------+
            /        |            |        \        \
+-----------+  +-----+----+  +----+----+ +-----+  +---------+
| SQL       |  | Mongo    |  | Neo4j   | | Vec |  | Search  |
| Dialects  |  | Dialect  |  | Dialect | | Dial|  | Dialect |
+-----------+  +----------+  +---------+ +-----+  +---------+
```

---

## 3. Threat Model & Security Architecture

### 3.1 Injection Vulnerabilities
* **SQL Injection**: Parameterization is strictly enforced. The query compiler never interpolates raw strings.
* **NoSQL Injection**: Structured filter parsing converts all query expressions to parameterized values or operators (e.g., MongoDB query filters), preventing raw script injections.

### 3.2 Row-Level Security (RLS)
* User session contexts are propagated down the query builder. The security engine injects mandatory filter nodes into the AST before query compilation (e.g., matching `tenant_id` or `user_id` values based on active context policies).

---

## 4. Reliability & Scalability Architecture

### 4.1 Connection Failover & Circuit Breaking
- When database connections fail, the `MultiDatabase` pool triggers a failover process routing traffic to secondary nodes.
- Short-circuits queries to databases flagged as unhealthy to avoid memory saturation and blockages.

### 4.2 Query Cache & Statement Caching
- Prevents database overloading by caching prepared statements and database query metadata locally or in a distributed Redis database.
