# BullDB for TypeScript & Node.js

> **One Model. Every Database. Unified Security, AI, and High-Performance for TypeScript/Node.js.**

BullDB is the world's most advanced cross-language ORM/ODM/Data Access Framework. This is the official npm package `@vikukumar/bulldb`.

With BullDB, you define a single Active Record model class and query it seamlessly across relational SQL engines (PostgreSQL, SQLite), document stores (MongoDB), key-value stores (Redis), and vector/graph databases under a unified schema-driven interface.

---

## Installation

Install the package and dependencies via `npm` or `yarn`:

```bash
npm install @vikukumar/bulldb reflect-metadata
```

Make sure to enable decorators in your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

---

## Key Features

1. **Decorator-Driven Models**: Native TS classes with `@Field`, `@PrimaryKey`, `@Unique`, and `@Index` decorators.
2. **Auto-Migrations**: Transparent schema diffing and table modification/reconstruction.
3. **Zero-Dependency Field Encryption**: Advanced AES-256-GCM secure field encryption with runtime key override (`SecurityEngine.setEncryptionKey`) and secure random fallbacks.
4. **Cross-Language Compatibility**: Standardized binary payload layout (`nonce (12b) + tag (16b) + ciphertext`) allowing decryption across Python, TypeScript, Go, Rust, and C#.
5. **NextAuth.js Compatibility**: Built-in NextAuth database adapters out of the box.
6. **Native AI Embeddings & RAG**: Seamless RAG ingestion pipelines.

---

## Quick Start Example

Here is a complete, ready-to-run TypeScript example:

```typescript
import "reflect-metadata";
import { BaseModel, PrimaryKey, Unique, Field, UUID, Email, EncryptedString, HashedPassword, db } from "@vikukumar/bulldb";
import { MigrationEngine } from "@vikukumar/bulldb";
import { SecurityEngine } from "@vikukumar/bulldb";

// 1. Define your Active Record model class
class User extends BaseModel {
  @PrimaryKey()
  @Field(UUID())
  id!: string;

  @Unique()
  @Field(Email())
  email!: string;

  @Field(EncryptedString())
  secretNote!: string;

  @Field(HashedPassword())
  password!: string;
}

async function main() {
  // 2. Setup Multi-Engine Database Connection
  BaseModel.setDb(db);
  await db.connectAll();
  
  // 3. Initialize and run schema migrations
  const migrator = new MigrationEngine(db);
  migrator.registerModel(User);
  await migrator.generateAndApplySchema();

  // 4. Optional: Override default encryption key at runtime
  // (Default: uses BULLDB_ENCRYPTION_KEY env, or generates a secure random session key)
  SecurityEngine.setEncryptionKey(Buffer.from("my-custom-super-secret-key-32b-length"));

  // 5. Create and save a user
  const user = await User.create({
    email: "developer@example.com",
    secretNote: "This is highly confidential TypeScript data.",
    password: "mySecurePassword123"
  });
  console.log(`Created User ID: ${user.id}`);
  
  // Note: Secret note is encrypted, and password is salted and hashed in the database!
  console.log(`Hashed Password in DB: ${user.password}`);

  // 6. Retrieve the user
  // Fetch by ID (automatic decryption of encrypted fields on load)
  const fetched = await User.getById(user.id);
  console.log(`Decrypted Secret Note: ${fetched.secretNote}`); // "This is highly confidential TypeScript data."

  // Find first record matching conditions
  const firstUser = await User.findFirst({ email: "developer@example.com" });
  console.log(`Found User ID: ${firstUser?.id}`);

  // 7. Serialize to JSON (JSON output exposes decrypted fields cleanly)
  const jsonOutput = user.toJSON();
  console.log("JSON Output:", jsonOutput);

  // 8. Clean up / delete user
  await user.delete();
  console.log("User deleted successfully.");
  
  await db.disconnectAll();
}

main().catch(console.error);
```

---

## NextAuth.js Integration

BullDB includes a built-in adapter for authentication flows with NextAuth.js:

```typescript
import NextAuth from "next-auth";
import { db } from "@vikukumar/bulldb";
import { BullDBNextAuthAdapter } from "@vikukumar/bulldb";

export default NextAuth({
  adapter: BullDBNextAuthAdapter(db),
  providers: [
    // Configure authentication providers...
  ],
});
```

---

## License

This package is licensed under the [MIT License](LICENSE.md).
