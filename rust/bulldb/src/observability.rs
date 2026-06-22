use std::collections::HashMap;
use std::sync::OnceLock;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct ObservabilityEngine {
    metrics: Mutex<HashMap<String, i64>>,
}

static TELEMETRY: OnceLock<ObservabilityEngine> = OnceLock::new();

fn get_telemetry() -> &'static ObservabilityEngine {
    TELEMETRY.get_or_init(|| ObservabilityEngine {
        metrics: Mutex::new(HashMap::new()),
    })
}

pub fn record_query_metrics(query: &str, duration: Duration) {
    let t = get_telemetry();
    let mut m = t.metrics.lock().unwrap();
    let count = m.entry("query_executions".to_string()).or_insert(0);
    *count += 1;
    println!("[TELEMETRY] Query: {}. Duration: {:?}", query, duration);
}

pub fn increment_metric(name: &str) {
    let t = get_telemetry();
    let mut m = t.metrics.lock().unwrap();
    let count = m.entry(name.to_string()).or_insert(0);
    *count += 1;
}

pub fn get_metric(name: &str) -> i64 {
    let t = get_telemetry();
    let m = t.metrics.lock().unwrap();
    *m.get(name).unwrap_or(&0)
}

pub struct TracingSpan {
    name: String,
    start_time: Instant,
}

impl TracingSpan {
    pub fn start(name: &str) -> Self {
        Self {
            name: name.to_string(),
            start_time: Instant::now(),
        }
    }

    pub fn finish(self) {
        println!("[TRACING] Span {} finished in {:?}", self.name, self.start_time.elapsed());
    }
}
