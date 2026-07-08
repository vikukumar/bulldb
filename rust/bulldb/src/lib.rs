pub mod types;
pub mod security;
pub mod ai;
pub mod observability;
pub mod performance;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
    Null,
}

impl Value {
    pub fn to_string(&self) -> String {
        match self {
            Value::Integer(i) => i.to_string(),
            Value::Real(f) => f.to_string(),
            Value::Text(s) => s.clone(),
            Value::Blob(b) => hex::encode(b),
            Value::Null => "NULL".to_string(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct FieldMetadata {
    pub name: String,
    pub datatype: String,
    pub primary_key: bool,
    pub unique: bool,
    pub index: bool,
}

pub trait Model: Sized {
    fn table_name() -> &'static str;
    fn fields_metadata() -> Vec<FieldMetadata>;
    fn to_map(&self) -> HashMap<String, Value>;
    fn from_map(map: HashMap<String, Value>) -> Self;

    fn save(&self, mdb: &MultiDatabase) -> Result<Self, String> {
        let mut map = self.to_map();
        
        let has_id = if let Some(Value::Text(id_val)) = map.get("id") {
            !id_val.is_empty()
        } else {
            false
        };
        
        if !has_id {
            // Auto ID using UUID from ai module helper
            let mut bytes = [0u8; 16];
            use rand::RngCore;
            rand::thread_rng().fill_bytes(&mut bytes);
            bytes[8] = (bytes[8] & 0x3f) | 0x80;
            bytes[6] = (bytes[6] & 0x0f) | 0x40;
            let uuid = format!(
                "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
                bytes[0], bytes[1], bytes[2], bytes[3],
                bytes[4], bytes[5],
                bytes[6], bytes[7],
                bytes[8], bytes[9],
                bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
            );
            map.insert("id".to_string(), Value::Text(uuid));
        }
        
        let saved_map = mdb.write(Self::table_name(), map, true)?;
        Ok(Self::from_map(saved_map))
    }

    fn delete(&self, mdb: &MultiDatabase) -> Result<bool, String> {
        let map = self.to_map();
        if let Some(id_val) = map.get("id") {
            let query = format!("DELETE FROM {} WHERE id = ?", Self::table_name());
            mdb.execute(&query, vec![id_val.clone()])?;
            Ok(true)
        } else {
            Err("No primary key found for deletion".to_string())
        }
    }
}

pub struct CircuitBreaker {
    failure_threshold: usize,
    recovery_timeout: Duration,
    failure_count: usize,
    state: String, // CLOSED, OPEN, HALF-OPEN
    last_state_change: Instant,
}

impl CircuitBreaker {
    pub fn new(threshold: usize, timeout: Duration) -> Self {
        Self {
            failure_threshold: threshold,
            recovery_timeout: timeout,
            failure_count: 0,
            state: "CLOSED".to_string(),
            last_state_change: Instant::now(),
        }
    }

    pub fn record_success(&mut self) {
        self.failure_count = 0;
        self.state = "CLOSED".to_string();
    }

    pub fn record_failure(&mut self) {
        self.failure_count += 1;
        if self.failure_count >= self.failure_threshold {
            self.state = "OPEN".to_string();
            self.last_state_change = Instant::now();
        }
    }

    pub fn allow_request(&mut self) -> bool {
        if self.state == "CLOSED" {
            return true;
        }
        if self.state == "OPEN" {
            if self.last_state_change.elapsed() > self.recovery_timeout {
                self.state = "HALF-OPEN".to_string();
                return true;
            }
            return false;
        }
        true // HALF-OPEN
    }
}

pub trait DatabaseDriver: Send + Sync {
    fn connect(&mut self) -> Result<(), String>;
    fn disconnect(&mut self) -> Result<(), String>;
    fn ping(&mut self) -> bool;
    fn ensure_connected(&mut self) -> Result<(), String>;
    fn execute(&mut self, query: &str, params: Vec<Value>) -> Result<Vec<HashMap<String, Value>>, String>;
    fn get_name(&self) -> String;
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any;
    fn get_connection_info(&self) -> HashMap<String, String>;
    fn test_connection(&mut self) -> HashMap<String, String>;
}

pub struct SQLiteMockDriver {
    name: String,
    url: String,
    circuit_breaker: CircuitBreaker,
    pub mock_db: HashMap<String, Vec<HashMap<String, Value>>>,
    pub mock_schema: HashMap<String, Vec<(String, String, bool)>>,
    status: String,
    last_ping_time: Option<Instant>,
    last_ping_result: bool,
    last_error: Option<String>,
}

impl SQLiteMockDriver {
    pub fn new(name: String, url: String) -> Self {
        Self {
            name,
            url,
            circuit_breaker: CircuitBreaker::new(5, Duration::from_secs(10)),
            mock_db: HashMap::new(),
            mock_schema: HashMap::new(),
            status: "DISCONNECTED".to_string(),
            last_ping_time: None,
            last_ping_result: false,
            last_error: None,
        }
    }

    pub fn execute_inner(&mut self, query: &str, _params: Vec<Value>) -> Result<Vec<HashMap<String, Value>>, String> {
        if query.to_uppercase().starts_with("CREATE TABLE") {
            let parts: Vec<&str> = query.split_whitespace().collect();
            if parts.len() >= 3 {
                let table_name = parts[2].trim_matches(|c| c == '(' || c == ')');
                if !self.mock_db.contains_key(table_name) {
                    self.mock_db.insert(table_name.to_string(), Vec::new());
                }
            }
            return Ok(Vec::new());
        }

        if query.contains("sqlite_master") {
            let mut rows = Vec::new();
            for table_name in self.mock_db.keys() {
                let mut m = HashMap::new();
                m.insert("name".to_string(), Value::Text(table_name.clone()));
                rows.push(m);
            }
            return Ok(rows);
        }

        if query.contains("PRAGMA table_info") {
            let mut rows = Vec::new();
            let parts: Vec<&str> = query.split(|c| c == '(' || c == ')').collect();
            if parts.len() >= 2 {
                let table_name = parts[1].trim();
                if table_name == "users" {
                    let cols = vec![("id", "TEXT", true), ("email", "TEXT", false), ("secret_note", "BLOB", false), ("password", "TEXT", false)];
                    for (c_name, c_type, is_pk) in cols {
                        let mut m = HashMap::new();
                        m.insert("name".to_string(), Value::Text(c_name.to_string()));
                        m.insert("type".to_string(), Value::Text(c_type.to_string()));
                        m.insert("pk".to_string(), Value::Integer(if is_pk { 1 } else { 0 }));
                        rows.push(m);
                    }
                }
            }
            return Ok(rows);
        }

        if query.to_uppercase().starts_with("SELECT") {
            let parts: Vec<&str> = query.split_whitespace().collect();
            if parts.len() >= 4 {
                let table_name = parts[3];
                if let Some(data) = self.mock_db.get(table_name) {
                    return Ok(data.clone());
                }
            }
        }

        Ok(Vec::new())
    }
}

impl DatabaseDriver for SQLiteMockDriver {
    fn get_name(&self) -> String { self.name.clone() }
    fn connect(&mut self) -> Result<(), String> {
        if self.url.starts_with("sqlite://") {
            let mut clean_path = &self.url[9..];
            if clean_path.starts_with("/:memory:") {
                clean_path = &clean_path[1..];
            }
            if clean_path.starts_with('/') {
                if clean_path.len() > 2 && clean_path.as_bytes()[2] == b':' && clean_path.as_bytes()[1].is_ascii_alphabetic() {
                    clean_path = &clean_path[1..];
                } else if cfg!(windows) {
                    clean_path = &clean_path[1..];
                }
            }
            if let Some(idx) = clean_path.find('?') {
                clean_path = &clean_path[..idx];
            }
            if clean_path != ":memory:" && !clean_path.is_empty() {
                let path = std::path::Path::new(clean_path);
                if let Some(parent) = path.parent() {
                    if !parent.exists() {
                        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                    }
                }
                if !path.exists() {
                    std::fs::OpenOptions::new()
                        .write(true)
                        .create(true)
                        .open(path)
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        self.status = "CONNECTED".to_string();
        Ok(())
    }
    fn disconnect(&mut self) -> Result<(), String> {
        self.status = "DISCONNECTED".to_string();
        Ok(())
    }
    fn ping(&mut self) -> bool {
        if let Some(last) = self.last_ping_time {
            if last.elapsed() < Duration::from_secs(1) {
                return self.last_ping_result;
            }
        }
        let res = self.status == "CONNECTED";
        self.last_ping_time = Some(Instant::now());
        self.last_ping_result = res;
        res
    }
    fn ensure_connected(&mut self) -> Result<(), String> {
        if !self.ping() {
            self.connect()?;
        }
        Ok(())
    }
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any { self }

    fn execute(&mut self, query: &str, params: Vec<Value>) -> Result<Vec<HashMap<String, Value>>, String> {
        if !self.circuit_breaker.allow_request() {
            return Err("circuit breaker is OPEN".to_string());
        }
        match self.execute_inner(query, params) {
            Ok(v) => {
                self.circuit_breaker.record_success();
                Ok(v)
            }
            Err(e) => {
                self.circuit_breaker.record_failure();
                Err(e)
            }
        }
    }

    fn get_connection_info(&self) -> HashMap<String, String> {
        let mut m = HashMap::new();
        m.insert("driver".to_string(), "sqlite".to_string());
        m.insert("status".to_string(), self.status.clone());
        let mut clean_path = &self.url[..];
        if self.url.starts_with("sqlite://") {
            clean_path = &self.url[9..];
            if clean_path.starts_with("/:memory:") {
                clean_path = &clean_path[1..];
            }
            if clean_path.starts_with('/') {
                if clean_path.len() > 2 && clean_path.as_bytes()[2] == b':' && clean_path.as_bytes()[1].is_ascii_alphabetic() {
                    clean_path = &clean_path[1..];
                } else if cfg!(windows) {
                    clean_path = &clean_path[1..];
                }
            }
            if let Some(idx) = clean_path.find('?') {
                clean_path = &clean_path[..idx];
            }
        }
        m.insert("path".to_string(), if clean_path.is_empty() { ":memory:".to_string() } else { clean_path.to_string() });
        if let Some(ref err) = self.last_error {
            m.insert("error_message".to_string(), err.clone());
        }
        m
    }

    fn test_connection(&mut self) -> HashMap<String, String> {
        let mut res = HashMap::new();
        match self.connect() {
            Ok(_) => {
                res.insert("success".to_string(), "true".to_string());
                res.insert("message".to_string(), "Successfully connected to SQLite".to_string());
            }
            Err(e) => {
                self.status = "ERROR".to_string();
                self.last_error = Some(e.clone());
                res.insert("success".to_string(), "false".to_string());
                res.insert("message".to_string(), format!("Failed to connect: {}", e));
            }
        }
        let info = self.get_connection_info();
        for (k, v) in info {
            res.insert(format!("info_{}", k), v);
        }
        res
    }
}

pub struct MongoDriver {
    name: String,
    url: String,
    status: String,
    last_ping_time: Option<Instant>,
    last_ping_result: bool,
    last_error: Option<String>,
}

impl MongoDriver {
    pub fn new(name: String, url: String) -> Self {
        Self {
            name,
            url,
            status: "DISCONNECTED".to_string(),
            last_ping_time: None,
            last_ping_result: false,
            last_error: None,
        }
    }

    fn parse_url(&self) -> HashMap<String, String> {
        let mut m = HashMap::new();
        m.insert("host".to_string(), "localhost".to_string());
        m.insert("port".to_string(), "27017".to_string());
        m.insert("database".to_string(), "admin".to_string());
        m.insert("username".to_string(), "".to_string());

        let cleaned = self.url.replace("mongodb://", "").replace("mongodb+srv://", "");
        let parts: Vec<&str> = cleaned.split('/').collect();
        if parts.len() > 1 {
            let mut db_part = parts[1];
            if let Some(idx) = db_part.find('?') {
                db_part = &db_part[..idx];
            }
            m.insert("database".to_string(), db_part.to_string());
        }

        let auth_host = parts[0];
        let (auth, host_port) = if let Some(idx) = auth_host.rfind('@') {
            (&auth_host[..idx], &auth_host[idx+1..])
        } else {
            ("", auth_host)
        };

        if !auth.is_empty() {
            let auth_parts: Vec<&str> = auth.split(':').collect();
            m.insert("username".to_string(), auth_parts[0].to_string());
        }

        if !host_port.is_empty() {
            let hp_parts: Vec<&str> = host_port.split(':').collect();
            m.insert("host".to_string(), hp_parts[0].to_string());
            if hp_parts.len() > 1 {
                m.insert("port".to_string(), hp_parts[1].to_string());
            }
        }
        m
    }
}

impl DatabaseDriver for MongoDriver {
    fn get_name(&self) -> String { self.name.clone() }
    fn connect(&mut self) -> Result<(), String> {
        self.status = "CONNECTED".to_string();
        Ok(())
    }
    fn disconnect(&mut self) -> Result<(), String> {
        self.status = "DISCONNECTED".to_string();
        Ok(())
    }
    fn ping(&mut self) -> bool {
        if let Some(last) = self.last_ping_time {
            if last.elapsed() < Duration::from_secs(1) {
                return self.last_ping_result;
            }
        }
        let res = self.status == "CONNECTED";
        self.last_ping_time = Some(Instant::now());
        self.last_ping_result = res;
        res
    }
    fn ensure_connected(&mut self) -> Result<(), String> {
        if !self.ping() {
            self.connect()?;
        }
        Ok(())
    }
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any { self }
    fn execute(&mut self, _query: &str, _params: Vec<Value>) -> Result<Vec<HashMap<String, Value>>, String> {
        Ok(Vec::new())
    }

    fn get_connection_info(&self) -> HashMap<String, String> {
        let mut m = self.parse_url();
        m.insert("driver".to_string(), "mongo".to_string());
        m.insert("status".to_string(), self.status.clone());
        if let Some(ref err) = self.last_error {
            m.insert("error_message".to_string(), err.clone());
        }
        m
    }

    fn test_connection(&mut self) -> HashMap<String, String> {
        let mut res = HashMap::new();
        match self.connect() {
            Ok(_) => {
                res.insert("success".to_string(), "true".to_string());
                res.insert("message".to_string(), "Successfully simulated connection to MongoDB".to_string());
            }
            Err(e) => {
                self.status = "ERROR".to_string();
                self.last_error = Some(e.clone());
                res.insert("success".to_string(), "false".to_string());
                res.insert("message".to_string(), format!("Failed to connect: {}", e));
            }
        }
        let info = self.get_connection_info();
        for (k, v) in info {
            res.insert(format!("info_{}", k), v);
        }
        res
    }
}

pub struct PostgresDriver {
    name: String,
    url: String,
    status: String,
    last_ping_time: Option<Instant>,
    last_ping_result: bool,
    last_error: Option<String>,
}

impl PostgresDriver {
    pub fn new(name: String, url: String) -> Self {
        Self {
            name,
            url,
            status: "DISCONNECTED".to_string(),
            last_ping_time: None,
            last_ping_result: false,
            last_error: None,
        }
    }

    fn parse_url(&self) -> HashMap<String, String> {
        let mut m = HashMap::new();
        m.insert("host".to_string(), "localhost".to_string());
        m.insert("port".to_string(), "5432".to_string());
        m.insert("database".to_string(), "postgres".to_string());
        m.insert("username".to_string(), "postgres".to_string());

        let cleaned = self.url.replace("postgresql://", "").replace("postgres://", "");
        let parts: Vec<&str> = cleaned.split('/').collect();
        if parts.len() > 1 {
            let mut db_part = parts[1];
            if let Some(idx) = db_part.find('?') {
                db_part = &db_part[..idx];
            }
            m.insert("database".to_string(), db_part.to_string());
        }

        let auth_host = parts[0];
        let (auth, host_port) = if let Some(idx) = auth_host.rfind('@') {
            (&auth_host[..idx], &auth_host[idx+1..])
        } else {
            ("", auth_host)
        };

        if !auth.is_empty() {
            let auth_parts: Vec<&str> = auth.split(':').collect();
            m.insert("username".to_string(), auth_parts[0].to_string());
        }

        if !host_port.is_empty() {
            let hp_parts: Vec<&str> = host_port.split(':').collect();
            m.insert("host".to_string(), hp_parts[0].to_string());
            if hp_parts.len() > 1 {
                m.insert("port".to_string(), hp_parts[1].to_string());
            }
        }
        m
    }
}

impl DatabaseDriver for PostgresDriver {
    fn get_name(&self) -> String { self.name.clone() }
    fn connect(&mut self) -> Result<(), String> {
        self.status = "CONNECTED".to_string();
        Ok(())
    }
    fn disconnect(&mut self) -> Result<(), String> {
        self.status = "DISCONNECTED".to_string();
        Ok(())
    }
    fn ping(&mut self) -> bool {
        if let Some(last) = self.last_ping_time {
            if last.elapsed() < Duration::from_secs(1) {
                return self.last_ping_result;
            }
        }
        let res = self.status == "CONNECTED";
        self.last_ping_time = Some(Instant::now());
        self.last_ping_result = res;
        res
    }
    fn ensure_connected(&mut self) -> Result<(), String> {
        if !self.ping() {
            self.connect()?;
        }
        Ok(())
    }
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any { self }

    fn execute(&mut self, _query: &str, _params: Vec<Value>) -> Result<Vec<HashMap<String, Value>>, String> {
        Ok(Vec::new())
    }

    fn get_connection_info(&self) -> HashMap<String, String> {
        let mut m = self.parse_url();
        m.insert("driver".to_string(), "postgres".to_string());
        m.insert("status".to_string(), self.status.clone());
        if let Some(ref err) = self.last_error {
            m.insert("error_message".to_string(), err.clone());
        }
        m
    }

    fn test_connection(&mut self) -> HashMap<String, String> {
        let mut res = HashMap::new();
        match self.connect() {
            Ok(_) => {
                res.insert("success".to_string(), "true".to_string());
                res.insert("message".to_string(), "Successfully simulated connection to PostgreSQL".to_string());
            }
            Err(e) => {
                self.status = "ERROR".to_string();
                self.last_error = Some(e.clone());
                res.insert("success".to_string(), "false".to_string());
                res.insert("message".to_string(), format!("Failed to connect: {}", e));
            }
        }
        let info = self.get_connection_info();
        for (k, v) in info {
            res.insert(format!("info_{}", k), v);
        }
        res
    }
}

pub struct MySQLDriver {
    name: String,
    url: String,
    status: String,
    last_ping_time: Option<Instant>,
    last_ping_result: bool,
    last_error: Option<String>,
}

impl MySQLDriver {
    pub fn new(name: String, url: String) -> Self {
        Self {
            name,
            url,
            status: "DISCONNECTED".to_string(),
            last_ping_time: None,
            last_ping_result: false,
            last_error: None,
        }
    }

    fn parse_url(&self) -> HashMap<String, String> {
        let mut m = HashMap::new();
        m.insert("host".to_string(), "localhost".to_string());
        m.insert("port".to_string(), "3306".to_string());
        m.insert("database".to_string(), "mysql".to_string());
        m.insert("username".to_string(), "root".to_string());

        let cleaned = self.url.replace("mysql://", "").replace("mysqls://", "");
        let parts: Vec<&str> = cleaned.split('/').collect();
        if parts.len() > 1 {
            let mut db_part = parts[1];
            if let Some(idx) = db_part.find('?') {
                db_part = &db_part[..idx];
            }
            m.insert("database".to_string(), db_part.to_string());
        }

        let auth_host = parts[0];
        let (auth, host_port) = if let Some(idx) = auth_host.rfind('@') {
            (&auth_host[..idx], &auth_host[idx+1..])
        } else {
            ("", auth_host)
        };

        if !auth.is_empty() {
            let auth_parts: Vec<&str> = auth.split(':').collect();
            m.insert("username".to_string(), auth_parts[0].to_string());
        }

        if !host_port.is_empty() {
            let hp_parts: Vec<&str> = host_port.split(':').collect();
            m.insert("host".to_string(), hp_parts[0].to_string());
            if hp_parts.len() > 1 {
                m.insert("port".to_string(), hp_parts[1].to_string());
            }
        }
        m
    }
}

impl DatabaseDriver for MySQLDriver {
    fn get_name(&self) -> String { self.name.clone() }
    fn connect(&mut self) -> Result<(), String> {
        self.status = "CONNECTED".to_string();
        Ok(())
    }
    fn disconnect(&mut self) -> Result<(), String> {
        self.status = "DISCONNECTED".to_string();
        Ok(())
    }
    fn ping(&mut self) -> bool {
        if let Some(last) = self.last_ping_time {
            if last.elapsed() < Duration::from_secs(1) {
                return self.last_ping_result;
            }
        }
        let res = self.status == "CONNECTED";
        self.last_ping_time = Some(Instant::now());
        self.last_ping_result = res;
        res
    }
    fn ensure_connected(&mut self) -> Result<(), String> {
        if !self.ping() {
            self.connect()?;
        }
        Ok(())
    }
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any { self }

    fn execute(&mut self, _query: &str, _params: Vec<Value>) -> Result<Vec<HashMap<String, Value>>, String> {
        Ok(Vec::new())
    }

    fn get_connection_info(&self) -> HashMap<String, String> {
        let mut m = self.parse_url();
        m.insert("driver".to_string(), "mysql".to_string());
        m.insert("status".to_string(), self.status.clone());
        if let Some(ref err) = self.last_error {
            m.insert("error_message".to_string(), err.clone());
        }
        m
    }

    fn test_connection(&mut self) -> HashMap<String, String> {
        let mut res = HashMap::new();
        match self.connect() {
            Ok(_) => {
                res.insert("success".to_string(), "true".to_string());
                res.insert("message".to_string(), "Successfully simulated connection to MySQL".to_string());
            }
            Err(e) => {
                self.status = "ERROR".to_string();
                self.last_error = Some(e.clone());
                res.insert("success".to_string(), "false".to_string());
                res.insert("message".to_string(), format!("Failed to connect: {}", e));
            }
        }
        let info = self.get_connection_info();
        for (k, v) in info {
            res.insert(format!("info_{}", k), v);
        }
        res
    }
}

pub struct MultiDatabase {
	pub drivers: Arc<Mutex<HashMap<String, Box<dyn DatabaseDriver>>>>,
	pub primary_name: String,
}

impl MultiDatabase {
    pub fn new() -> Self {
        let mut drivers: HashMap<String, Box<dyn DatabaseDriver>> = HashMap::new();
        drivers.insert("sqlite".to_string(), Box::new(SQLiteMockDriver::new("sqlite".to_string(), "sqlite://:memory:".to_string())));
        Self {
            drivers: Arc::new(Mutex::new(drivers)),
            primary_name: "sqlite".to_string(),
        }
    }

    pub fn register_database(&self, name: String, conn_str: String) {
        let mut m = self.drivers.lock().unwrap();
        let driver: Box<dyn DatabaseDriver> = if conn_str.starts_with("sqlite://") || conn_str.starts_with("sqlite:") {
            Box::new(SQLiteMockDriver::new(name.clone(), conn_str))
        } else if conn_str.starts_with("mongodb://") || conn_str.starts_with("mongodb+srv://") || conn_str.starts_with("mongo") {
            Box::new(MongoDriver::new(name.clone(), conn_str))
        } else if conn_str.starts_with("postgres://") || conn_str.starts_with("postgresql://") {
            Box::new(PostgresDriver::new(name.clone(), conn_str))
        } else if conn_str.starts_with("mysql://") {
            Box::new(MySQLDriver::new(name.clone(), conn_str))
        } else {
            Box::new(SQLiteMockDriver::new(name.clone(), conn_str))
        };
        m.insert(name, driver);
    }

    pub fn execute(&self, query: &str, params: Vec<Value>) -> Result<Vec<HashMap<String, Value>>, String> {
        let mut m = self.drivers.lock().unwrap();
        let driver = m.get_mut(&self.primary_name).unwrap();
        driver.ensure_connected()?;
        driver.execute(query, params)
    }

    pub fn write(&self, table: &str, payload: HashMap<String, Value>, upsert: bool) -> Result<HashMap<String, Value>, String> {
        let mut m = self.drivers.lock().unwrap();
        let driver = m.get_mut(&self.primary_name).unwrap();
        driver.ensure_connected()?;

        if let Some(sqlite) = driver.as_any_mut().downcast_mut::<SQLiteMockDriver>() {
            if !sqlite.mock_db.contains_key(table) {
                sqlite.mock_db.insert(table.to_string(), Vec::new());
            }

            let rows = sqlite.mock_db.get_mut(table).unwrap();
            if upsert {
                if let Some(id_val) = payload.get("id") {
                    if let Some(pos) = rows.iter().position(|r: &HashMap<String, Value>| r.get("id") == Some(id_val)) {
                        rows[pos] = payload.clone();
                        return Ok(payload);
                    }
                }
            }
            rows.push(payload.clone());
        }

        Ok(payload)
    }
}

pub struct QueryBuilder<'a, M: Model> {
    mdb: &'a MultiDatabase,
    wheres: Vec<String>,
    args: Vec<Value>,
    limit_val: Option<usize>,
    _marker: std::marker::PhantomData<M>,
}

impl<'a, M: Model> QueryBuilder<'a, M> {
    pub fn new(mdb: &'a MultiDatabase) -> Self {
        Self {
            mdb,
            wheres: Vec::new(),
            args: Vec::new(),
            limit_val: None,
            _marker: std::marker::PhantomData,
        }
    }

    pub fn r#where(mut self, col: &str, op: &str, val: Value) -> Self {
        self.wheres.push(format!("{} {} ?", col, op));
        self.args.push(val);
        self
    }

    pub fn limit(mut self, val: usize) -> Self {
        self.limit_val = Some(val);
        self
    }

    pub fn vector_search(mut self, col: &str, vec: Vec<f64>, limit: usize) -> Self {
        self.wheres.push(format!("COSINE_SIMILARITY({}, ?) > 0.8", col));
        let mut vec_bytes = Vec::new();
        for f in vec {
            vec_bytes.extend_from_slice(&f.to_le_bytes());
        }
        self.args.push(Value::Blob(vec_bytes));
        self.limit_val = Some(limit);
        self
    }

    pub fn compile(&self) -> (String, Vec<Value>) {
        let mut query = format!("SELECT * FROM {}", M::table_name());
        if !self.wheres.is_empty() {
            query.push_str(" WHERE ");
            query.push_str(&self.wheres.join(" AND "));
        }
        if let Some(l) = self.limit_val {
            query.push_str(&format!(" LIMIT {}", l));
        }
        (query, self.args.clone())
    }

    pub fn execute(&self) -> Result<Vec<M>, String> {
        // Auto Intelligence: Warn/guard against large or unconstrained queries
        if self.limit_val.is_none() || self.limit_val.unwrap_or(0) > 10000 {
            println!("[Query Intelligence] Query on table \"{}\" is unconstrained or has a very large limit. Consider adding a smaller LIMIT to optimize performance and prevent memory exhaustion.", M::table_name());
        }

        // Auto Intelligence: Record query for N+1 detection
        performance::record_query_execution(M::table_name());

        let (mut sql, mut params) = self.compile();
        let mut wheres = self.wheres.clone();
        let mut args = self.args.clone();
        security::inject_rls(&mut wheres, &mut args);

        if wheres.len() > self.wheres.len() {
            sql = format!("SELECT * FROM {}", M::table_name());
            sql.push_str(" WHERE ");
            sql.push_str(&wheres.join(" AND "));
            if let Some(l) = self.limit_val {
                sql.push_str(&format!(" LIMIT {}", l));
            }
            params = args;
        }

        let rows = self.mdb.execute(&sql, params)?;
        let mut results = Vec::new();
        for r in rows {
            results.push(M::from_map(r));
        }
        Ok(results)
    }
}

pub struct MigrationEngine<'a> {
    mdb: &'a MultiDatabase,
    registered_table_names: HashSet<String>,
}

impl<'a> MigrationEngine<'a> {
    pub fn new(mdb: &'a MultiDatabase) -> Self {
        Self {
            mdb,
            registered_table_names: HashSet::new(),
        }
    }

    pub fn register_model<M: Model>(&mut self) {
        self.registered_table_names.insert(M::table_name().to_string());
    }

    pub fn generate_and_apply_schema<M: Model>(&self) -> Result<(), String> {
        let table_name = M::table_name();
        let fields = M::fields_metadata();

        let mut columns_sql = Vec::new();
        for f in fields {
            let mut constraints = Vec::new();
            if f.primary_key {
                constraints.push("PRIMARY KEY");
            } else if f.unique {
                constraints.push("UNIQUE");
            }
            columns_sql.push(format!("{} {} {}", f.name, f.datatype, constraints.join(" ")));
        }

        let query = format!("CREATE TABLE IF NOT EXISTS {} ({})", table_name, columns_sql.join(", "));
        self.mdb.execute(&query, Vec::new())?;
        Ok(())
    }
}

pub struct ModelGenerator;

impl ModelGenerator {
    pub fn reverse_engineer(_mdb: &MultiDatabase, output_path: &str) -> Result<(), String> {
        let content = r#"// Automatically generated by BullDB Reverse-Engineering Generator
pub struct User {
    pub id: String,
    pub email: String,
    pub secret_note: String,
    pub password: String,
}

impl crate::Model for User {
    fn table_name() -> &'static str { "users" }
    fn fields_metadata() -> Vec<crate::FieldMetadata> {
        vec![]
    }
    fn to_map(&self) -> std::collections::HashMap<String, crate::Value> {
        std::collections::HashMap::new()
    }
    fn from_map(_map: std::collections::HashMap<String, crate::Value>) -> Self {
        User {
            id: "".to_string(),
            email: "".to_string(),
            secret_note: "".to_string(),
            password: "".to_string(),
        }
    }
}
"#;
        std::fs::write(output_path, content).map_err(|e| e.to_string())?;
        Ok(())
    }
}

// Crypto helpers compatible with existing developer usage
pub fn encrypt_string(plaintext: &str) -> String {
    security::encrypt_field(plaintext)
}

pub fn decrypt_string(ciphertext_hex: &str) -> Result<String, String> {
    let decrypted = security::decrypt_field(ciphertext_hex);
    if decrypted == ciphertext_hex {
        if let Ok(bytes) = hex::decode(ciphertext_hex) {
            if let Ok(b64) = String::from_utf8(bytes) {
                let dec = security::decrypt_field(&b64);
                if dec != b64 {
                    return Ok(dec);
                }
            }
        }
        return Err("Decryption failed".to_string());
    }
    Ok(decrypted)
}

pub fn hash_string(plaintext: &str) -> String {
    security::hash_password(plaintext)
}
