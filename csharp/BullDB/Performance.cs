using System;
using System.Collections.Generic;

namespace BullDB
{
    public class CacheItem
    {
        public object Value { get; set; } = null!;
        public DateTime Expiration { get; set; }
    }

    public class TTLPerformanceCache
    {
        private readonly Dictionary<string, CacheItem> _items = new Dictionary<string, CacheItem>();
        private readonly object _lock = new object();

        public static TTLPerformanceCache Instance { get; } = new TTLPerformanceCache();

        public void Set(string key, object val, TimeSpan ttl)
        {
            lock (_lock)
            {
                _items[key] = new CacheItem
                {
                    Value = val,
                    Expiration = DateTime.UtcNow + ttl
                };
            }
        }

        public object? Get(string key)
        {
            lock (_lock)
            {
                if (_items.TryGetValue(key, out var item))
                {
                    if (DateTime.UtcNow < item.Expiration) return item.Value;
                    _items.Remove(key);
                }
                return null;
            }
        }
    }

    public class N1QueryDetector
    {
        private readonly Dictionary<string, List<DateTime>> _queryHistory = new Dictionary<string, List<DateTime>>();
        private readonly object _lock = new object();

        public static N1QueryDetector Instance { get; } = new N1QueryDetector();

        public void RecordQuery(string table)
        {
            lock (_lock)
            {
                var now = DateTime.UtcNow;
                if (!_queryHistory.ContainsKey(table)) _queryHistory[table] = new List<DateTime>();
                
                var executions = _queryHistory[table];
                executions.Add(now);

                // Filter last 5 seconds
                executions.RemoveAll(t => (now - t).TotalSeconds > 5);

                if (executions.Count > 10)
                {
                    Console.WriteLine($"[WARNING] Possible N+1 Query pattern detected on table: {table}. {executions.Count} executions in 5 seconds.");
                }
            }
        }
    }
}
