using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using BullDB;
using Xunit;

namespace BullDB.Tests
{
    [Table("testusers")]
    public class TestUser : BaseModel
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

    [Table("documents")]
    public class TestDocument : BaseModel
    {
        [PrimaryKey]
        public string Id { get; set; } = "";

        public string Text { get; set; } = "";

        public double[] VectorVal { get; set; } = Array.Empty<double>();
    }

    public class ModelsTests
    {
        [Fact]
        public async Task TestActiveRecordFlow()
        {
            var db = DB.Instance;
            await db.ConnectAllAsync();

            var mig = new MigrationEngine();
            mig.RegisterModel(typeof(TestUser));
            await mig.GenerateAndApplySchemaAsync();

            // Create
            var user = await BaseModel.CreateAsync<TestUser>(new Dictionary<string, object>
            {
                { "Email", "test_cs@example.com" },
                { "SecretNote", "Top Secret C# Note" },
                { "Password", "mySecurePasswordCSharp" }
            });

            Assert.False(string.IsNullOrEmpty(user.Id));

            // Verify encryption and hashing in database payload
            var rawDbRows = await db.ExecuteAsync($"SELECT * FROM testusers WHERE id = ?", new object[] { user.Id });
            Assert.Single(rawDbRows);
            var rawRow = rawDbRows[0];

            var secretNoteInDb = (string)rawRow["secretnote"];
            var passwordInDb = (string)rawRow["password"];

            Assert.NotEqual("Top Secret C# Note", secretNoteInDb);
            Assert.NotEqual("mySecurePasswordCSharp", passwordInDb);

            // Verify password hashing logic
            Assert.True(SecurityEngine.VerifyPassword("mySecurePasswordCSharp", passwordInDb));

            // GetById
            var fetched = await BaseModel.GetByIdAsync<TestUser>(user.Id);
            Assert.Equal("test_cs@example.com", fetched.Email);
            Assert.Equal("Top Secret C# Note", fetched.SecretNote); // Decrypted on load

            // FindFirst
            var first = await BaseModel.FindFirstAsync<TestUser>(new Dictionary<string, object> { { "email", "test_cs@example.com" } });
            Assert.NotNull(first);
            Assert.Equal(user.Id, first.Id);

            // Count
            var count = await BaseModel.CountAsync<TestUser>(new Dictionary<string, object> { { "email", "test_cs@example.com" } });
            Assert.Equal(1, count);

            // Reload
            user.Email = "modified@example.com";
            await user.ReloadAsync();
            Assert.Equal("test_cs@example.com", user.Email);

            // ToJSON
            var json = user.ToJSON();
            Assert.Equal("Top Secret C# Note", json["secretnote"]);

            // Delete
            var deleted = await user.DeleteAsync();
            Assert.True(deleted);

            var countAfter = await BaseModel.CountAsync<TestUser>();
            Assert.Equal(0, countAfter);

            await db.DisconnectAllAsync();
        }

        [Fact]
        public async Task TestReverseEngineeringGenerator()
        {
            var db = DB.Instance;
            var outPath = Path.Combine(Path.GetTempPath(), "generated_cs_models.cs");

            await ModelGenerator.ReverseEngineer(db, outPath);
            Assert.True(File.Exists(outPath));

            var content = await File.ReadAllTextAsync(outPath);
            Assert.Contains("public class User", content);
        }

        [Fact]
        public async Task TestRAGPipeline()
        {
            var db = DB.Instance;
            await db.ConnectAllAsync();

            var mig = new MigrationEngine();
            mig.RegisterModel(typeof(TestDocument));
            await mig.GenerateAndApplySchemaAsync();

            var pipeline = new RAGPipeline<TestDocument>(db, "VectorVal", "Text");
            var inserted = await pipeline.IngestDocumentAsync("This is a C# RAG pipeline test document.");
            Assert.NotEmpty(inserted);

            var results = await pipeline.QuerySimilarityAsync("RAG pipeline", 1);
            Assert.NotEmpty(results);

            await db.DisconnectAllAsync();
        }

        [Fact]
        public void TestPerformanceAndTelemetry()
        {
            var cache = TTLPerformanceCache.Instance;
            cache.Set("cs_key", "cs_value", TimeSpan.FromMilliseconds(500));

            var val = (string?)cache.Get("cs_key");
            Assert.Equal("cs_value", val);

            Thread.Sleep(600);
            Assert.Null(cache.Get("cs_key"));

            var telemetry = ObservabilityEngine.Telemetry;
            telemetry.IncrementMetric("cs_tests_run");
            Assert.Equal(1, telemetry.GetMetric("cs_tests_run"));
        }

        [Fact]
        public async Task TestSQLiteAutoCreation()
        {
            var tempDir = Path.Combine(Path.GetTempPath(), "bulldb_cs_test_" + Guid.NewGuid().ToString());
            var dbFile = Path.Combine(tempDir, "nested", "subdir", "test.db");
            var dbUrl = "sqlite://" + dbFile;

            var db = new MultiDatabase();
            db.RegisterDatabase("sqlite_file", dbUrl);
            var driver = db.Drivers["sqlite_file"];

            await driver.ConnectAsync();

            Assert.True(File.Exists(dbFile));
            Assert.True(Directory.Exists(Path.GetDirectoryName(dbFile)));

            try
            {
                Directory.Delete(tempDir, true);
            }
            catch {}
        }

        [Fact]
        public async Task TestOOPDriversAndConnectionInfo()
        {
            var db = new MultiDatabase();
            db.RegisterDatabase("my_pg", "postgresql://dbuser:secretpass@dbhost:5432/mydb");
            db.RegisterDatabase("my_mysql", "mysql://root:password123@127.0.0.1:3306/testdb");
            db.RegisterDatabase("my_mongo", "mongodb://admin:pass@localhost:27017/admindb");
            db.RegisterDatabase("my_sqlite", "sqlite:///data/store.db");

            Assert.IsType<PostgresDriver>(db.Drivers["my_pg"]);
            Assert.IsType<MySQLDriver>(db.Drivers["my_mysql"]);
            Assert.IsType<MongoDriver>(db.Drivers["my_mongo"]);
            Assert.IsType<SQLiteMockDriver>(db.Drivers["my_sqlite"]);

            // Postgres info
            var pgInfo = db.Drivers["my_pg"].GetConnectionInfo();
            Assert.Equal("postgres", pgInfo["driver"]);
            Assert.Equal("dbhost", pgInfo["host"]);
            Assert.Equal(5432, pgInfo["port"]);
            Assert.Equal("mydb", pgInfo["database"]);
            Assert.Equal("dbuser", pgInfo["username"]);

            // MySQL info
            var mysqlInfo = db.Drivers["my_mysql"].GetConnectionInfo();
            Assert.Equal("mysql", mysqlInfo["driver"]);
            Assert.Equal("127.0.0.1", mysqlInfo["host"]);
            Assert.Equal(3306, mysqlInfo["port"]);
            Assert.Equal("testdb", mysqlInfo["database"]);
            Assert.Equal("root", mysqlInfo["username"]);

            // Connection testing
            var testRes = await db.Drivers["my_pg"].TestConnectionAsync();
            Assert.True((bool)testRes["success"]);
            var innerInfo = (Dictionary<string, object>)testRes["info"];
            Assert.Equal("CONNECTED", innerInfo["status"]);
        }
    }
}

