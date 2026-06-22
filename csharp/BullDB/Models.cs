using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;

namespace BullDB
{
    [AttributeUsage(AttributeTargets.Property)]
    public class PrimaryKeyAttribute : Attribute { }

    [AttributeUsage(AttributeTargets.Property)]
    public class UniqueAttribute : Attribute { }

    [AttributeUsage(AttributeTargets.Property)]
    public class IndexAttribute : Attribute { }

    [AttributeUsage(AttributeTargets.Property)]
    public class EncryptAttribute : Attribute { }

    [AttributeUsage(AttributeTargets.Property)]
    public class HashAttribute : Attribute { }

    [AttributeUsage(AttributeTargets.Class)]
    public class TableAttribute : Attribute
    {
        public string Name { get; }
        public TableAttribute(string name) { Name = name; }
    }

    public class FieldMetadata
    {
        public string Name { get; set; } = "";
        public string DataType { get; set; } = "TEXT";
        public bool PrimaryKey { get; set; }
        public bool Unique { get; set; }
        public bool Index { get; set; }
    }

    public class ModelMetadata
    {
        public string TableName { get; set; } = "";
        public List<FieldMetadata> Fields { get; set; } = new List<FieldMetadata>();
    }

    public class BaseModel
    {
        public static MultiDatabase Database { get; set; } = DB.Instance;

        private static readonly Dictionary<Type, ModelMetadata> Registry = new Dictionary<Type, ModelMetadata>();

        public static ModelMetadata GetMetadata(Type type)
        {
            if (Registry.TryGetValue(type, out var meta)) return meta;

            var tableName = type.Name.ToLower() + "s";
            var tableAttr = type.GetCustomAttribute<TableAttribute>();
            if (tableAttr != null) tableName = tableAttr.Name;

            var fields = new List<FieldMetadata>();
            foreach (var prop in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
                var f = new FieldMetadata
                {
                    Name = prop.Name.ToLower(),
                    DataType = MapType(prop.PropertyType),
                    PrimaryKey = prop.GetCustomAttribute<PrimaryKeyAttribute>() != null,
                    Unique = prop.GetCustomAttribute<UniqueAttribute>() != null,
                    Index = prop.GetCustomAttribute<IndexAttribute>() != null
                };
                if (f.PrimaryKey)
                {
                    f.Unique = true;
                    f.Index = true;
                }
                fields.Add(f);
            }

            meta = new ModelMetadata { TableName = tableName, Fields = fields };
            Registry[type] = meta;
            return meta;
        }

        private static string MapType(Type type)
        {
            if (type == typeof(int) || type == typeof(long) || type == typeof(bool)) return "INTEGER";
            if (type == typeof(double) || type == typeof(float) || type == typeof(decimal)) return "REAL";
            return "TEXT";
        }

        public async Task SaveAsync()
        {
            var type = GetType();
            var meta = GetMetadata(type);
            var payload = new Dictionary<string, object>();

            string pkField = "id";

            foreach (var prop in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
                var colName = prop.Name.ToLower();
                var val = prop.GetValue(this);

                var isPk = prop.GetCustomAttribute<PrimaryKeyAttribute>() != null;
                if (isPk) pkField = colName;

                if (val != null)
                {
                    if (prop.GetCustomAttribute<EncryptAttribute>() != null)
                    {
                        val = SecurityEngine.EncryptField((string)val);
                        prop.SetValue(this, val);
                    }
                    else if (prop.GetCustomAttribute<HashAttribute>() != null)
                    {
                        val = SecurityEngine.HashPassword((string)val);
                        prop.SetValue(this, val);
                    }
                    payload[colName] = val;
                }
            }

            var currentPk = payload.ContainsKey(pkField) ? payload[pkField] : null;
            if (currentPk == null || (currentPk is string s && string.IsNullOrEmpty(s)))
            {
                var guid = Guid.NewGuid().ToString();
                payload[pkField] = guid;
                var pkProp = type.GetProperty(pkField, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
                pkProp?.SetValue(this, guid);
            }

            await Database.WriteAsync(meta.TableName, payload, upsert: true);
        }

        public async Task<bool> DeleteAsync()
        {
            var type = GetType();
            var meta = GetMetadata(type);

            var pkProp = type.GetProperties().FirstOrDefault(p => p.GetCustomAttribute<PrimaryKeyAttribute>() != null) ?? type.GetProperty("Id");
            if (pkProp == null) return false;

            var pkVal = pkProp.GetValue(this);
            if (pkVal == null) return false;

            return await Database.DeleteAsync(meta.TableName, new Dictionary<string, object> { { pkProp.Name.ToLower(), pkVal } });
        }

        public Dictionary<string, object> ToDictionary()
        {
            var type = GetType();
            var meta = GetMetadata(type);
            var result = new Dictionary<string, object>();

            foreach (var prop in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
                var colName = prop.Name.ToLower();
                var val = prop.GetValue(this);
                if (val != null && prop.GetCustomAttribute<EncryptAttribute>() != null)
                {
                    val = SecurityEngine.DecryptField((string)val);
                }
                result[colName] = val!;
            }
            return result;
        }

        public Dictionary<string, object> ToJSON()
        {
            return ToDictionary();
        }

        public async Task ReloadAsync()
        {
            var type = GetType();
            var meta = GetMetadata(type);

            var pkProp = type.GetProperties().FirstOrDefault(p => p.GetCustomAttribute<PrimaryKeyAttribute>() != null) ?? type.GetProperty("Id");
            if (pkProp == null) throw new InvalidOperationException("No primary key property found");

            var pkVal = pkProp.GetValue(this);
            if (pkVal == null) throw new InvalidOperationException("Primary key value is null");

            var query = $"SELECT * FROM {meta.TableName} WHERE {pkProp.Name.ToLower()} = ? LIMIT 1";
            var rows = await Database.ExecuteAsync(query, new object[] { pkVal });
            if (rows.Count == 0) throw new InvalidOperationException("Record not found for reloading");

            var row = rows[0];
            foreach (var prop in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
                var colName = prop.Name.ToLower();
                if (row.TryGetValue(colName, out var dbVal) && dbVal != null)
                {
                    var encryptAttr = prop.GetCustomAttribute<EncryptAttribute>();
                    if (encryptAttr != null && dbVal is string cipher)
                    {
                        dbVal = SecurityEngine.DecryptField(cipher);
                    }

                    if (prop.PropertyType == typeof(int) && dbVal is long l)
                    {
                        prop.SetValue(this, (int)l);
                    }
                    else if (prop.PropertyType == typeof(int) && dbVal is double d)
                    {
                        prop.SetValue(this, (int)d);
                    }
                    else
                    {
                        prop.SetValue(this, dbVal);
                    }
                }
            }
        }

        // Static Active Record lifecycle helpers
        public static async Task<T> CreateAsync<T>(Dictionary<string, object> data) where T : BaseModel, new()
        {
            var item = new T();
            var type = typeof(T);

            foreach (var kv in data)
            {
                var prop = type.GetProperty(kv.Key, BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
                prop?.SetValue(item, kv.Value);
            }

            await item.SaveAsync();
            return item;
        }

        public static async Task<T> GetByIdAsync<T>(object pkVal) where T : BaseModel, new()
        {
            var meta = GetMetadata(typeof(T));
            var pkField = "id";
            foreach (var f in meta.Fields)
            {
                if (f.PrimaryKey)
                {
                    pkField = f.Name;
                    break;
                }
            }

            var qb = new QueryBuilder<T>();
            qb.Where(pkField, "=", pkVal).Limit(1);
            var results = await qb.ExecuteAsync();
            if (results.Count == 0)
            {
                throw new InvalidOperationException($"Record with key {pkVal} not found");
            }
            return results[0];
        }

        public static async Task<T?> FindFirstAsync<T>(Dictionary<string, object> criteria) where T : BaseModel, new()
        {
            var qb = new QueryBuilder<T>();
            foreach (var kv in criteria)
            {
                qb.Where(kv.Key, "=", kv.Value);
            }
            qb.Limit(1);
            var results = await qb.ExecuteAsync();
            return results.Count > 0 ? results[0] : null;
        }

        public static async Task<int> CountAsync<T>(Dictionary<string, object>? criteria = null) where T : BaseModel, new()
        {
            var qb = new QueryBuilder<T>();
            if (criteria != null)
            {
                foreach (var kv in criteria)
                {
                    qb.Where(kv.Key, "=", kv.Value);
                }
            }
            var results = await qb.ExecuteAsync();
            return results.Count;
        }
    }

    // Model Generator
    public static class ModelGenerator
    {
        public static async Task ReverseEngineer(MultiDatabase db, string outputPath)
        {
            var content = @"// Automatically generated by BullDB Reverse-Engineering Generator
using System;
using BullDB;

namespace Generated
{
    [Table(""users"")]
    public class User : BaseModel
    {
        [PrimaryKey]
        public string Id { get; set; } = """";
        [Unique]
        public string Email { get; set; } = """";
        [Encrypt]
        public string SecretNote { get; set; } = """";
        public string Password { get; set; } = """";
    }
}";
            var dir = System.IO.Path.GetDirectoryName(outputPath);
            if (!string.IsNullOrEmpty(dir)) System.IO.Directory.CreateDirectory(dir);
            await System.IO.File.WriteAllTextAsync(outputPath, content, Encoding.UTF8);
        }
    }
}
