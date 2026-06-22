using System;
using System.Collections.Generic;

namespace BullDB
{
    public class ObservabilityEngine
    {
        private readonly Dictionary<string, long> _metrics = new Dictionary<string, long>();
        private readonly object _lock = new object();

        public static ObservabilityEngine Telemetry { get; } = new ObservabilityEngine();

        public void RecordQueryMetrics(string query, TimeSpan duration)
        {
            lock (_lock)
            {
                IncrementMetric("query_executions");
                Console.WriteLine($"[TELEMETRY] Query: {query}. Duration: {duration}");
            }
        }

        public void IncrementMetric(string name)
        {
            lock (_lock)
            {
                if (!_metrics.ContainsKey(name)) _metrics[name] = 0;
                _metrics[name]++;
            }
        }

        public long GetMetric(string name)
        {
            lock (_lock)
            {
                return _metrics.TryGetValue(name, out var val) ? val : 0;
            }
        }
    }

    public class TracingSpan : IDisposable
    {
        public string Name { get; }
        public DateTime StartTime { get; }

        public TracingSpan(string name)
        {
            Name = name;
            StartTime = DateTime.UtcNow;
        }

        public void Dispose()
        {
            var elapsed = DateTime.UtcNow - StartTime;
            Console.WriteLine($"[TRACING] Span {Name} finished in {elapsed}");
        }
    }
}
