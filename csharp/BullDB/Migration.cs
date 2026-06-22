using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace BullDB
{
    public class MigrationEngine
    {
        private readonly MultiDatabase _db;
        private readonly List<Type> _registeredModels = new List<Type>();

        public MigrationEngine()
        {
            _db = DB.Instance;
        }

        public void RegisterModel(Type modelType)
        {
            if (!_registeredModels.Contains(modelType))
            {
                _registeredModels.Add(modelType);
            }
        }

        private string NormalizeType(string t)
        {
            t = t.ToUpper();
            if (t.Contains("INT") || t.Contains("SERIAL")) return "INTEGER";
            if (t.Contains("CHAR") || t.Contains("TEXT") || t.Contains("UUID") || t.Contains("EMAIL") || t.Contains("PHONE") || t.Contains("URL") || t.Contains("IPADDRESS")) return "TEXT";
            if (t.Contains("REAL") || t.Contains("FLOAT") || t.Contains("DOUBLE") || t.Contains("NUMERIC") || t.Contains("DECIMAL")) return "REAL";
            if (t.Contains("BLOB") || t.Contains("BYTEA") || t.Contains("BINARY")) return "BLOB";
            return "TEXT";
        }

        private async Task RecreateTableSqliteAsync(string tableName, ModelMetadata meta)
        {
            var driver = _db.GetRoute(tableName, true);
            await driver.ExecuteAsync("PRAGMA foreign_keys = OFF");
            try
            {
                var pragmaRows = await driver.ExecuteAsync($"PRAGMA table_info({tableName})");
                var dbCols = new HashSet<string>(pragmaRows.Select(r => (string)r["name"]));
                var commonCols = meta.Fields.Select(f => f.Name).Where(name => dbCols.Contains(name)).ToList();

                var tempName = $"{tableName}_old_{DateTimeOffset.UtcNow.ToUnixTimeSeconds()}";
                await driver.ExecuteAsync($"ALTER TABLE {tableName} RENAME TO {tempName}");

                var colDefs = new List<string>();
                foreach (var f in meta.Fields)
                {
                    var constraints = f.PrimaryKey ? "PRIMARY KEY" : (f.Unique ? "UNIQUE" : "");
                    colDefs.Add($"{f.Name} {f.DataType} {constraints}");
                }

                var createSql = $"CREATE TABLE {tableName} ({string.Join(", ", colDefs)})";
                await driver.ExecuteAsync(createSql);

                if (commonCols.Count > 0)
                {
                    var colsStr = string.Join(", ", commonCols);
                    var copySql = $"INSERT INTO {tableName} ({colsStr}) SELECT {colsStr} FROM {tempName}";
                    await driver.ExecuteAsync(copySql);
                }

                await driver.ExecuteAsync($"DROP TABLE {tempName}");
            }
            finally
            {
                await driver.ExecuteAsync("PRAGMA foreign_keys = ON");
            }
        }

        public async Task GenerateAndApplySchemaAsync()
        {
            var driver = _db.GetRoute("", true);

            var dbTables = new List<string>();
            try
            {
                var rows = await driver.ExecuteAsync("SELECT name FROM sqlite_master WHERE type='table'");
                foreach (var r in rows) dbTables.Add((string)r["name"]);
            }
            catch { }

            var modelTables = new HashSet<string>(_registeredModels.Select(m => BaseModel.GetMetadata(m).TableName));

            // 1. Drop tables
            foreach (var table in dbTables)
            {
                if (!modelTables.Contains(table) && table != "sys_migrations" && !table.StartsWith("sqlite_"))
                {
                    await driver.ExecuteAsync($"DROP TABLE IF EXISTS {table}");
                }
            }

            // 2. Diff and migrate
            foreach (var modelType in _registeredModels)
            {
                var meta = BaseModel.GetMetadata(modelType);
                var tableName = meta.TableName;
                var tableExists = dbTables.Contains(tableName);

                if (!tableExists)
                {
                    var colDefs = new List<string>();
                    foreach (var f in meta.Fields)
                    {
                        var constraints = f.PrimaryKey ? "PRIMARY KEY" : (f.Unique ? "UNIQUE" : "");
                        colDefs.Add($"{f.Name} {f.DataType} {constraints}");
                    }
                    var createSql = $"CREATE TABLE {tableName} ({string.Join(", ", colDefs)})";
                    await driver.ExecuteAsync(createSql);
                }
                else
                {
                    var pragmaRows = await driver.ExecuteAsync($"PRAGMA table_info({tableName})");
                    var existingColumns = new Dictionary<string, Dictionary<string, object>>();
                    foreach (var r in pragmaRows)
                    {
                        existingColumns[(string)r["name"]] = r;
                    }

                    bool needsRecreation = false;

                    foreach (var f in meta.Fields)
                    {
                        if (!existingColumns.ContainsKey(f.Name))
                        {
                            if (f.PrimaryKey || f.Unique)
                            {
                                needsRecreation = true;
                            }
                            else
                            {
                                var alterSql = $"ALTER TABLE {tableName} ADD COLUMN {f.Name} {f.DataType}";
                                await driver.ExecuteAsync(alterSql);
                            }
                        }
                        else
                        {
                            var dbCol = existingColumns[f.Name];
                            var dbType = (string)dbCol["type"];
                            var dbPkVal = Convert.ToInt64(dbCol["pk"]);
                            var dbPk = dbPkVal == 1;

                            if (NormalizeType(dbType) != NormalizeType(f.DataType) || f.PrimaryKey != dbPk)
                            {
                                needsRecreation = true;
                            }
                        }
                    }

                    foreach (var name in existingColumns.Keys)
                    {
                        if (!meta.Fields.Any(f => f.Name == name) && name != "id")
                        {
                            needsRecreation = true;
                        }
                    }

                    if (needsRecreation)
                    {
                        await RecreateTableSqliteAsync(tableName, meta);
                    }
                }

                // Indexes
                foreach (var f in meta.Fields)
                {
                    var idxName = $"{tableName}_{f.Name}_idx";
                    if (f.Index && !f.PrimaryKey)
                    {
                        await driver.ExecuteAsync($"CREATE INDEX IF NOT EXISTS {idxName} ON {tableName} ({f.Name})");
                    }
                    else
                    {
                        await driver.ExecuteAsync($"DROP INDEX IF EXISTS {idxName}");
                    }
                }
            }
        }
    }
}
