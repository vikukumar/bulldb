using System;
using System.Collections.Generic;
using System.Data;
using System.Threading;
using System.Threading.Tasks;

namespace BullDB
{
    public interface IDatabaseDriver
    {
        string Name { get; }
        Task ConnectAsync();
        Task DisconnectAsync();
        Task<bool> PingAsync();
        Task EnsureConnectedAsync();
        Task<List<Dictionary<string, object>>> ExecuteAsync(string query, params object[] args);
        Task<Dictionary<string, object>> InsertAsync(string table, Dictionary<string, object> payload);
        Task<Dictionary<string, object>> UpdateAsync(string table, Dictionary<string, object> payload, Dictionary<string, object> filters);
        Task<bool> DeleteAsync(string table, Dictionary<string, object> filters);
    }

    public class CircuitBreaker
    {
        private readonly int _threshold;
        private readonly TimeSpan _timeout;
        private int _failures = 0;
        private string _state = "CLOSED";
        private DateTime _lastTrip = DateTime.MinValue;

        public CircuitBreaker(int threshold, TimeSpan timeout)
        {
            _threshold = threshold;
            _timeout = timeout;
        }

        public void RecordSuccess()
        {
            _failures = 0;
            _state = "CLOSED";
        }

        public void RecordFailure()
        {
            _failures++;
            if (_failures >= _threshold)
            {
                _state = "OPEN";
                _lastTrip = DateTime.UtcNow;
            }
        }

        public bool AllowRequest()
        {
            if (_state == "CLOSED") return true;
            if (_state == "OPEN")
            {
                if (DateTime.UtcNow - _lastTrip > _timeout)
                {
                    _state = "HALF-OPEN";
                    return true;
                }
                return false;
            }
            return true; // HALF-OPEN
        }
    }

    public class SQLiteMockDriver : IDatabaseDriver
    {
        public string Name { get; }
        private readonly string _dsn;
        private readonly CircuitBreaker _cb = new CircuitBreaker(5, TimeSpan.FromSeconds(10));
        private readonly object _lock = new object();
        public Dictionary<string, List<Dictionary<string, object>>> MockDb = new Dictionary<string, List<Dictionary<string, object>>>();

        public SQLiteMockDriver(string name, string dsn)
        {
            Name = name;
            _dsn = dsn;
        }

        public Task ConnectAsync()
        {
            lock (_lock)
            {
                if (_dsn != null && _dsn.StartsWith("sqlite://"))
                {
                    var cleanPath = _dsn.Substring(9);
                    if (cleanPath.StartsWith("/"))
                    {
                        if (cleanPath.Length > 2 && cleanPath[2] == ':' && char.IsLetter(cleanPath[1]))
                        {
                            cleanPath = cleanPath.Substring(1);
                        }
                        else if (System.Runtime.InteropServices.RuntimeInformation.IsOSPlatform(System.Runtime.InteropServices.OSPlatform.Windows))
                        {
                            cleanPath = cleanPath.Substring(1);
                        }
                    }
                    int qIdx = cleanPath.IndexOf('?');
                    if (qIdx != -1)
                    {
                        cleanPath = cleanPath.Substring(0, qIdx);
                    }
                    if (cleanPath != ":memory:" && !string.IsNullOrEmpty(cleanPath))
                    {
                        var fullPath = System.IO.Path.GetFullPath(cleanPath);
                        var dir = System.IO.Path.GetDirectoryName(fullPath);
                        if (dir != null && !System.IO.Directory.Exists(dir))
                        {
                            System.IO.Directory.CreateDirectory(dir);
                        }
                        if (!System.IO.File.Exists(fullPath))
                        {
                            System.IO.File.Create(fullPath).Dispose();
                        }
                    }
                }
            }
            return Task.CompletedTask;
        }

        public Task DisconnectAsync() => Task.CompletedTask;
        public Task<bool> PingAsync() => Task.FromResult(true);
        public Task EnsureConnectedAsync() => Task.CompletedTask;

        public Task<List<Dictionary<string, object>>> ExecuteAsync(string query, params object[] args)
        {
            lock (_lock)
            {
                if (!_cb.AllowRequest()) throw new InvalidOperationException("circuit breaker is OPEN");

                try
                {
                    var results = new List<Dictionary<string, object>>();

                    if (query.ToUpper().Contains("CREATE TABLE"))
                    {
                        var parts = query.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                        if (parts.Length >= 3)
                        {
                            var table = parts[2].Trim('(', ')', ',');
                            if (!MockDb.ContainsKey(table))
                            {
                                MockDb[table] = new List<Dictionary<string, object>>();
                            }
                        }
                        _cb.RecordSuccess();
                        return Task.FromResult(results);
                    }

                    if (query.Contains("sqlite_master"))
                    {
                        foreach (var table in MockDb.Keys)
                        {
                            results.Add(new Dictionary<string, object> { { "name", table } });
                        }
                        _cb.RecordSuccess();
                        return Task.FromResult(results);
                    }

                    if (query.Contains("PRAGMA table_info"))
                    {
                        var parts = query.Split('(', ')');
                        if (parts.Length >= 2)
                        {
                            var table = parts[1].Trim();
                            if (table == "users")
                            {
                                results.Add(new Dictionary<string, object> { { "name", "id" }, { "type", "TEXT" }, { "pk", 1 } });
                                results.Add(new Dictionary<string, object> { { "name", "email" }, { "type", "TEXT" }, { "pk", 0 } });
                                results.Add(new Dictionary<string, object> { { "name", "secret_note" }, { "type", "BLOB" }, { "pk", 0 } });
                                results.Add(new Dictionary<string, object> { { "name", "password" }, { "type", "TEXT" }, { "pk", 0 } });
                            }
                        }
                        _cb.RecordSuccess();
                        return Task.FromResult(results);
                    }

                    if (query.ToUpper().StartsWith("SELECT"))
                    {
                        var parts = query.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                        if (parts.Length >= 4)
                        {
                            var table = parts[3];
                            if (MockDb.ContainsKey(table))
                            {
                                _cb.RecordSuccess();
                                return Task.FromResult(new List<Dictionary<string, object>>(MockDb[table]));
                            }
                        }
                    }

                    _cb.RecordSuccess();
                    return Task.FromResult(results);
                }
                catch (Exception)
                {
                    _cb.RecordFailure();
                    throw;
                }
            }
        }

        public Task<Dictionary<string, object>> InsertAsync(string table, Dictionary<string, object> payload)
        {
            lock (_lock)
            {
                if (!MockDb.ContainsKey(table)) MockDb[table] = new List<Dictionary<string, object>>();
                MockDb[table].Add(payload);
                return Task.FromResult(payload);
            }
        }

        public Task<Dictionary<string, object>> UpdateAsync(string table, Dictionary<string, object> payload, Dictionary<string, object> filters)
        {
            lock (_lock)
            {
                if (!MockDb.ContainsKey(table)) return Task.FromResult(payload);
                foreach (var row in MockDb[table])
                {
                    bool match = true;
                    foreach (var filter in filters)
                    {
                        if (!row.ContainsKey(filter.Key) || !row[filter.Key].Equals(filter.Value))
                        {
                            match = false;
                            break;
                        }
                    }
                    if (match)
                    {
                        foreach (var pair in payload) row[pair.Key] = pair.Value;
                    }
                }
                return Task.FromResult(payload);
            }
        }

        public Task<bool> DeleteAsync(string table, Dictionary<string, object> filters)
        {
            lock (_lock)
            {
                if (!MockDb.ContainsKey(table)) return Task.FromResult(false);
                int initialCount = MockDb[table].Count;
                MockDb[table].RemoveAll(row =>
                {
                    bool match = true;
                    foreach (var filter in filters)
                    {
                        if (!row.ContainsKey(filter.Key) || !row[filter.Key].Equals(filter.Value))
                        {
                            match = false;
                            break;
                        }
                    }
                    return match;
                });
                return Task.FromResult(MockDb[table].Count < initialCount);
            }
        }
    }

    public class MultiDatabase
    {
        public Dictionary<string, IDatabaseDriver> Drivers { get; } = new Dictionary<string, IDatabaseDriver>();
        public string PrimaryName { get; set; } = "sqlite";

        public MultiDatabase()
        {
            RegisterDatabase("sqlite", "sqlite://:memory:");
        }

        public void RegisterDatabase(string name, string connStr)
        {
            Drivers[name] = new SQLiteMockDriver(name, connStr);
        }

        public async Task ConnectAllAsync()
        {
            foreach (var driver in Drivers.Values) await driver.ConnectAsync();
        }

        public async Task DisconnectAllAsync()
        {
            foreach (var driver in Drivers.Values) await driver.DisconnectAsync();
        }

        public IDatabaseDriver GetRoute(string table, bool isWrite)
        {
            return Drivers[PrimaryName];
        }

        public async Task<List<Dictionary<string, object>>> ExecuteAsync(string query, params object[] args)
        {
            var driver = GetRoute("", false);
            return await RetryWithBackoffAsync(driver, () => driver.ExecuteAsync(query, args));
        }

        public async Task<Dictionary<string, object>> WriteAsync(string table, Dictionary<string, object> payload, bool upsert)
        {
            var driver = GetRoute(table, true);
            await driver.EnsureConnectedAsync();

            if (upsert && payload.ContainsKey("id"))
            {
                var pkVal = payload["id"];
                if (pkVal != null)
                {
                    var sql = $"SELECT id FROM {table} WHERE id = ?";
                    var rows = await driver.ExecuteAsync(sql, pkVal);
                    if (rows != null && rows.Count > 0)
                    {
                        var filters = new Dictionary<string, object> { { "id", pkVal } };
                        var payloadNoPk = new Dictionary<string, object>();
                        foreach (var pair in payload)
                        {
                            if (pair.Key != "id") payloadNoPk[pair.Key] = pair.Value;
                        }
                        return await driver.UpdateAsync(table, payloadNoPk, filters);
                    }
                }
            }

            return await driver.InsertAsync(table, payload);
        }

        public async Task<bool> DeleteAsync(string table, Dictionary<string, object> filters)
        {
            var driver = GetRoute(table, true);
            await driver.EnsureConnectedAsync();
            return await driver.DeleteAsync(table, filters);
        }

        private async Task<T> RetryWithBackoffAsync<T>(IDatabaseDriver driver, Func<Task<T>> fn, int retries = 3, int initialDelay = 500)
        {
            int delay = initialDelay;
            Exception lastEx = null!;

            for (int i = 0; i < retries; i++)
            {
                try
                {
                    await driver.EnsureConnectedAsync();
                    return await fn();
                }
                catch (Exception ex)
                {
                    lastEx = ex;
                    await Task.Delay(delay);
                    delay *= 2;
                }
            }
            throw new Exception("Database execution retries exhausted.", lastEx);
        }
    }

    public static class DB
    {
        public static MultiDatabase Instance = new MultiDatabase();
    }
}
