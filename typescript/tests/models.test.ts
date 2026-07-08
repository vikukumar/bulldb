import { BaseModel, PrimaryKey, Unique, Field, UUID, Email, EncryptedString, HashedPassword, db } from "../src";
import { MigrationEngine } from "../src/migration";
import { SecurityEngine } from "../src/security";

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

describe("TypeScript Universal Model Active Record Suite", () => {
  beforeAll(async () => {
    BaseModel.setDb(db);
    await db.connectAll();
    
    const mig = new MigrationEngine(db);
    mig.registerModel(User);
    await mig.generateAndApplySchema();
  });

  afterAll(async () => {
    await db.disconnectAll();
  });

  it("should persist user, encrypt and hash secret fields, and fetch successfully", async () => {
    const user = await User.create({
      email: "test_ts@example.com",
      secretNote: "Top Secret TS Note",
      password: "mySecurePasswordTS"
    });

    expect(user.id).toBeDefined();

    // Verify hashing and encryption are correctly resolved
    expect(user.secretNote).not.toBe("Top Secret TS Note");
    expect(user.password).not.toBe("mySecurePasswordTS");

    // Test getById & findFirst
    const fetched = await User.getById(user.id);
    expect(fetched.email).toBe("test_ts@example.com");

    const first = await User.findFirst({ email: "test_ts@example.com" });
    expect(first).not.toBeNull();
    expect(first?.id).toBe(user.id);

    // Test count
    const total = await User.count();
    expect(total).toBe(1);

    // Test reload
    user.email = "modified@example.com";
    await user.reload();
    expect(user.email).toBe("test_ts@example.com");

    // Test toJSON decryptions
    const json = user.toJSON();
    expect(json.email).toBe("test_ts@example.com");
    expect(json.secretNote).toBe("Top Secret TS Note");

    // Cleanup
    await user.delete();
    const countAfter = await User.count();
    expect(countAfter).toBe(0);
  });

  it("should reverse-engineer SQLite databases and write TS models classes", async () => {
    const fs = require("fs");
    const path = require("path");
    const os = require("os");
    const { ModelGenerator } = require("../src/generator");

    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "bulldb-"));
    const outputPath = path.join(tmpdir, "generated.ts");

    await ModelGenerator.reverseEngineer(db, outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);
    
    const content = fs.readFileSync(outputPath, "utf-8");
    expect(content).toContain("class User extends BaseModel");
    expect(content).toContain("id!:");
  });

  it("should validate NextAuth adapter binding functions", () => {
    const { BullDBNextAuthAdapter } = require("../src/adapters/auth");
    const adapter = BullDBNextAuthAdapter(db);
    expect(adapter).toHaveProperty("createUser");
    expect(adapter).toHaveProperty("getUser");
    expect(adapter).toHaveProperty("getUserByEmail");
  });

  it("should perform advanced schema-diff auto-migrations and SQLite table reconstruction", async () => {
    const { Model, BaseModel, PrimaryKey, Field, Index, UUID, UniversalType } = require("../src");
    const { MigrationEngine } = require("../src/migration");
    
    @Model("evolution_test")
    class SchemaV1 extends BaseModel {
      @PrimaryKey()
      @Field(UUID())
      id!: string;

      @Field(new UniversalType("String"))
      title!: string;

      @Field(new UniversalType("String"))
      oldVal!: string;

      @Index()
      @Field(new UniversalType("String"))
      indexedCol!: string;
    }

    const mig = new MigrationEngine(db);
    mig.registerModel(SchemaV1);
    await mig.generateAndApplySchema();

    // Insert record
    await SchemaV1.create({
      id: "11111111-2222-3333-4444-555555555555",
      title: "Hello TS",
      oldVal: "RemoveMe TS",
      indexedCol: "IndexMe TS"
    });

    // Verify V1 schema in mock db
    let pragmaRows = await db.execute("PRAGMA table_info(evolution_test)");
    let cols = pragmaRows.map((r: any) => r.name);
    expect(cols).toContain("oldVal");
    expect(cols).toContain("indexedCol");

    // Upgrade: SchemaV2 (added newVal, dropped oldVal, updated title type, removed index)
    @Model("evolution_test")
    class SchemaV2 extends BaseModel {
      @PrimaryKey()
      @Field(UUID())
      id!: string;

      @Field(new UniversalType("Number"))
      title!: number;

      @Field(new UniversalType("String"))
      newVal!: string;

      @Field(new UniversalType("String"))
      indexedCol!: string;
    }

    const mig2 = new MigrationEngine(db);
    mig2.registerModel(SchemaV2);
    await mig2.generateAndApplySchema();

    // Verify V2 schema
    pragmaRows = await db.execute("PRAGMA table_info(evolution_test)");
    const colTypes: Record<string, string> = {};
    for (const r of pragmaRows) {
      colTypes[r.name] = r.type;
    }
    
    expect(colTypes.newVal).toBeDefined();
    expect(colTypes.oldVal).toBeUndefined();
    expect(colTypes.title).toBe("REAL"); // number maps to REAL in SQLite

    // Verify V2 data
    const rows = await db.execute("SELECT * FROM evolution_test");
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe("11111111-2222-3333-4444-555555555555");
    expect(rows[0].indexedCol).toBe("IndexMe TS");
  });
});

describe("TypeScript SQLite Auto-Creation", () => {
  it("should create directory and file automatically on connect", async () => {
    const fs = require("fs");
    const path = require("path");
    const os = require("os");
    const { MultiDatabase } = require("../src/database");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bulldb-ts-test-"));
    const dbFile = path.join(tmpDir, "nested", "subdir", "test.db");
    const dbUrl = `sqlite://${dbFile}`;

    const testDb = new MultiDatabase();
    testDb.registerDatabase("sqlite_file", dbUrl);
    const driver = testDb.drivers.get("sqlite_file");

    await driver!.connect();

    expect(fs.existsSync(dbFile)).toBe(true);
    expect(fs.existsSync(path.dirname(dbFile))).toBe(true);

    // Clean up
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("TypeScript OOP Database Drivers & Connection Info", () => {
  const { MultiDatabase, SQLiteDriver, PostgresDriver, MySQLDriver, MongoDriver } = require("../src/database");

  it("should correctly instantiate the respective driver classes based on URL", () => {
    const db = new MultiDatabase();
    db.registerDatabase("my_pg", "postgresql://dbuser:secretpass@dbhost:5432/mydb");
    db.registerDatabase("my_mysql", "mysql://root:password123@127.0.0.1:3306/testdb?charset=utf8");
    db.registerDatabase("my_mongo", "mongodb://admin:pass@localhost:27017/admindb");
    db.registerDatabase("my_sqlite", "sqlite://data/store.db");

    expect(db.drivers.get("my_pg")).toBeInstanceOf(PostgresDriver);
    expect(db.drivers.get("my_mysql")).toBeInstanceOf(MySQLDriver);
    expect(db.drivers.get("my_mongo")).toBeInstanceOf(MongoDriver);
    expect(db.drivers.get("my_sqlite")).toBeInstanceOf(SQLiteDriver);
  });

  it("should parse and return connection info for PostgresDriver", () => {
    const driver = new PostgresDriver("my_pg", "postgres://dbuser:secretpass@dbhost:5432/mydb");
    const info = driver.getConnectionInfo();
    expect(info.driver).toBe("postgres");
    expect(info.host).toBe("dbhost");
    expect(info.port).toBe(5432);
    expect(info.database).toBe("mydb");
    expect(info.username).toBe("dbuser");
    expect(info.status).toBe("DISCONNECTED");
  });

  it("should parse and return connection info for MySQLDriver", () => {
    const driver = new MySQLDriver("my_mysql", "mysql://root:password123@127.0.0.1:3306/testdb");
    const info = driver.getConnectionInfo();
    expect(info.driver).toBe("mysql");
    expect(info.host).toBe("127.0.0.1");
    expect(info.port).toBe(3306);
    expect(info.database).toBe("testdb");
    expect(info.username).toBe("root");
    expect(info.status).toBe("DISCONNECTED");
  });

  it("should parse and return connection info for MongoDriver", () => {
    const driver = new MongoDriver("my_mongo", "mongodb://admin:pass@localhost:27017/admindb");
    const info = driver.getConnectionInfo();
    expect(info.driver).toBe("mongo");
    expect(info.host).toBe("localhost");
    expect(info.port).toBe(27017);
    expect(info.database).toBe("admindb");
    expect(info.username).toBe("admin");
    expect(info.status).toBe("DISCONNECTED");
  });

  it("should test connection status", async () => {
    const driver = new PostgresDriver("my_pg", "postgres://dbuser:secretpass@dbhost:5432/mydb");
    const result = await driver.testConnection();
    expect(result.success).toBe(true);
    expect(result.message).toContain("Successfully simulated connection");
    expect(result.info.status).toBe("CONNECTED");
  });
});


