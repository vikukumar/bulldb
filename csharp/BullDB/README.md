# BullDB for C# & .NET

> **One Model. Every Database. Unified Security, AI, and High-Performance for C# / .NET.**

BullDB is the world's most advanced cross-language ORM/ODM/Data Access Framework. This is the official NuGet package `BullDB`.

With BullDB, you define a single Active Record model class and query it seamlessly across relational SQL engines (PostgreSQL, SQLite), document stores (MongoDB), key-value stores (Redis), and vector/graph databases under a unified schema-driven interface.

---

## Installation

Install the package via the .NET CLI:

```bash
dotnet add package BullDB
```

Or via the Package Manager Console:

```powershell
Install-Package BullDB
```

---

## Key Features

1. **Attribute-Driven Models**: Native C# classes decorated with `[Table]`, `[PrimaryKey]`, `[Unique]`, `[Encrypt]`, and `[Hash]`.
2. **Auto-Migrations**: Transparent schema diffing and table modification/reconstruction.
3. **Zero-Dependency Field Encryption**: Advanced AES-256-GCM secure field encryption with runtime key override (`SecurityEngine.SetEncryptionKey`) and secure random fallbacks.
4. **Cross-Language Compatibility**: Standardized binary payload layout (`nonce (12b) + tag (16b) + ciphertext`) allowing decryption across Python, TypeScript, Go, Rust, and C#.
5. **Asynchronous API**: Fully async-await compatible methods for database operations.
6. **Native AI Embeddings & RAG**: Built-in HTTP clients and similarity search pipelines.

---

## Quick Start Example

Here is a complete, ready-to-run C# example:

```csharp
using System;
using System.Collections.Generic;
using System.Text;
using System.Threading.Tasks;
using BullDB;

namespace BullDBExample
{
    // 1. Define your Active Record model class with Attributes
    [Table("users")]
    public class User : BaseModel
    {
        [PrimaryKey]
        public string Id { get; set; } = "";

        [Unique]
        public string Email { get; set; } = "";

        [Encrypt]
        public string SecretNote { get; set; } = "";

        [Hash]
        public string Password { get; set; } = "";
    }

    class Program
    {
        static async Task Main(string[] args)
        {
            // 2. Setup Multi-Engine Database Connection
            var db = DB.Instance;
            await db.ConnectAllAsync();

            // 3. Initialize and run schema migrations
            var migrator = new MigrationEngine();
            migrator.RegisterModel(typeof(User));
            await migrator.GenerateAndApplySchemaAsync();

            // 4. Optional: Override default encryption key at runtime
            // (Default: uses BULLDB_ENCRYPTION_KEY env, or generates a secure random session key)
            SecurityEngine.SetEncryptionKey(Encoding.UTF8.GetBytes("my-custom-super-secret-key-32b-length"));

            // 5. Create and save a user
            var user = await BaseModel.CreateAsync<User>(new Dictionary<string, object>
            {
                { "Email", "developer@example.com" },
                { "SecretNote", "This is highly confidential C# data." },
                { "Password", "mySecurePassword123" }
            });
            Console.WriteLine($"Created User ID: {user.Id}");

            // Note: SecretNote is encrypted and Password is salted + hashed in the database!
            // Let's verify password verification flow
            var rawRows = await db.ExecuteAsync("SELECT * FROM users WHERE id = ?", new object[] { user.Id });
            var hashedPasswordInDb = (string)rawRows[0]["password"];
            bool isPasswordCorrect = SecurityEngine.VerifyPassword("mySecurePassword123", hashedPasswordInDb);
            Console.WriteLine($"Password Matches: {isPasswordCorrect}"); // True

            // 6. Retrieve the user
            // Fetch by ID (automatic decryption of encrypted fields on load)
            var fetched = await BaseModel.GetByIdAsync<User>(user.Id);
            Console.WriteLine($"Decrypted Secret Note: {fetched.SecretNote}"); // "This is highly confidential C# data."

            // Find first record matching conditions
            var firstUser = await BaseModel.FindFirstAsync<User>(new Dictionary<string, object> { { "email", "developer@example.com" } });
            Console.WriteLine($"Found User ID: {firstUser?.Id}");

            // 7. Clean up / delete user
            bool deleted = await user.DeleteAsync();
            Console.WriteLine($"User Deleted: {deleted}");

            await db.DisconnectAllAsync();
        }
    }
}
```

---

## AI Embeddings & RAG Pipelines

C# includes a built-in semantic search RAG Pipeline:

```csharp
using BullDB;

var db = DB.Instance;
var pipeline = new RAGPipeline<TestDocument>(db, "VectorVal", "Text");

// Ingest a document
string docId = await pipeline.IngestDocumentAsync("High performance .NET data management.");

// Query similarity
var results = await pipeline.QuerySimilarityAsync("data management", 1);
Console.WriteLine($"Similarity Match: {results[0].Text}");
```

---

## License

This package is licensed under the [MIT License](LICENSE.md).
