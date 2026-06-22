use std::collections::HashMap;
use std::sync::OnceLock;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Clone)]
struct CacheItem {
    value: String, // String serialized payload
    expiration: Instant,
}

pub struct TTLPerformanceCache {
    items: Mutex<HashMap<String, CacheItem>>,
}

static CACHE: OnceLock<TTLPerformanceCache> = OnceLock::new();

fn get_cache() -> &'static TTLPerformanceCache {
    CACHE.get_or_init(|| TTLPerformanceCache {
        items: Mutex::new(HashMap::new()),
    })
}

pub fn cache_set(key: &str, value: &str, ttl: Duration) {
    let c = get_cache();
    let mut m = c.items.lock().unwrap();
    m.insert(key.to_string(), CacheItem {
        value: value.to_string(),
        expiration: Instant::now() + ttl,
    });
}

pub fn cache_get(key: &str) -> Option<String> {
    let c = get_cache();
    let mut m = c.items.lock().unwrap();
    if let Some(item) = m.get(key) {
        if Instant::now() < item.expiration {
            return Some(item.value.clone());
        }
    }
    m.remove(key);
    None
}

// N+1 Query Detector
pub struct N1QueryDetector {
    query_history: Mutex<HashMap<String, Vec<Instant>>>,
}

static DETECTOR: OnceLock<N1QueryDetector> = OnceLock::new();

fn get_detector() -> &'static N1QueryDetector {
    DETECTOR.get_or_init(|| N1QueryDetector {
        query_history: Mutex::new(HashMap::new()),
    })
}

pub fn record_query_execution(table: &str) {
    let d = get_detector();
    let mut history = d.query_history.lock().unwrap();
    let now = Instant::now();
    let executions = history.entry(table.to_string()).or_insert(Vec::new());
    
    executions.push(now);
    
    // Clean old records (> 5s)
    executions.retain(|&t| now.duration_since(t) < Duration::from_secs(5));

    if executions.len() > 10 {
        println!("[WARNING] Possible N+1 Query pattern detected on table: {}. {} executions in 5 seconds.", table, executions.len());
    }
}
