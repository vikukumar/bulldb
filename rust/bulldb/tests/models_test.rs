use std::collections::HashMap;
use std::time::Duration;
use bulldb::{Model, Value, FieldMetadata, MultiDatabase, QueryBuilder, MigrationEngine, ModelGenerator, security, ai, performance, observability};

struct TestUser {
    id: String,
    email: String,
    secret_note: String,
    password: String,
}

impl Model for TestUser {
    fn table_name() -> &'static str { "testusers" }

    fn fields_metadata() -> Vec<FieldMetadata> {
        vec![
            FieldMetadata { name: "id".to_string(), datatype: "TEXT".to_string(), primary_key: true, unique: true, index: true },
            FieldMetadata { name: "email".to_string(), datatype: "TEXT".to_string(), primary_key: false, unique: true, index: true },
            FieldMetadata { name: "secret_note".to_string(), datatype: "BLOB".to_string(), primary_key: false, unique: false, index: false },
            FieldMetadata { name: "password".to_string(), datatype: "TEXT".to_string(), primary_key: false, unique: false, index: false },
        ]
    }

    fn to_map(&self) -> HashMap<String, Value> {
        let mut m = HashMap::new();
        m.insert("id".to_string(), Value::Text(self.id.clone()));
        m.insert("email".to_string(), Value::Text(self.email.clone()));
        m.insert("secret_note".to_string(), Value::Blob(bulldb::encrypt_string(&self.secret_note).into_bytes()));
        m.insert("password".to_string(), Value::Text(bulldb::hash_string(&self.password)));
        m
    }

    fn from_map(mut map: HashMap<String, Value>) -> Self {
        let id = match map.remove("id").unwrap_or(Value::Null) { Value::Text(s) => s, _ => "".to_string() };
        let email = match map.remove("email").unwrap_or(Value::Null) { Value::Text(s) => s, _ => "".to_string() };
        let secret_note = match map.remove("secret_note").unwrap_or(Value::Null) {
            Value::Blob(b) => {
                let s_hex = String::from_utf8(b).unwrap_or_default();
                bulldb::decrypt_string(&s_hex).unwrap_or_default()
            },
            _ => "".to_string(),
        };
        let password = match map.remove("password").unwrap_or(Value::Null) { Value::Text(s) => s, _ => "".to_string() };
        TestUser { id, email, secret_note, password }
    }
}

#[test]
fn test_rust_active_record_flow() {
    let mdb = MultiDatabase::new();
    let mut mig = MigrationEngine::new(&mdb);
    mig.register_model::<TestUser>();
    mig.generate_and_apply_schema::<TestUser>().unwrap();

    let user = TestUser {
        id: "12345678-1234-1234-1234-1234567890ab".to_string(),
        email: "test_rust@example.com".to_string(),
        secret_note: "Top Secret Rust Note".to_string(),
        password: "mySecurePasswordRust".to_string(),
    };

    // Save
    let saved = user.save(&mdb).unwrap();
    assert_ne!(saved.id, "");

    // Verify Encryption and Hashing
    let payload = user.to_map();
    let enc_bytes = match payload.get("secret_note").unwrap() {
        Value::Blob(b) => b,
        _ => panic!("Expected blob"),
    };
    let enc_str = String::from_utf8(enc_bytes.clone()).unwrap();
    assert_ne!(enc_str, "Top Secret Rust Note");
    assert_eq!(bulldb::decrypt_string(&enc_str).unwrap(), "Top Secret Rust Note");

    let hashed_pw = match payload.get("password").unwrap() {
        Value::Text(s) => s,
        _ => panic!("Expected text"),
    };
    assert_ne!(hashed_pw, "mySecurePasswordRust");
    assert!(security::verify_password("mySecurePasswordRust", hashed_pw));

    // Query builder
    let qb = QueryBuilder::<TestUser>::new(&mdb);
    let results = qb.r#where("email", "=", Value::Text("test_rust@example.com".to_string()))
                    .limit(1)
                    .execute()
                    .unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].email, "test_rust@example.com");
    assert_eq!(results[0].secret_note, "Top Secret Rust Note");
}

#[test]
fn test_rust_reverse_engineering_generator() {
    let mdb = MultiDatabase::new();
    let temp_dir = std::env::temp_dir();
    let out_path = temp_dir.join("generated_models.rs");
    let out_str = out_path.to_str().unwrap();

    ModelGenerator::reverse_engineer(&mdb, out_str).unwrap();
    let content = std::fs::read_to_string(out_str).unwrap();
    assert!(content.contains("pub struct User"));
}

#[test]
fn test_rust_rag_pipeline() {
    let mdb = MultiDatabase::new();
    
    struct Document {
        id: String,
        text: String,
        vector_val: Vec<u8>,
    }

    impl Model for Document {
        fn table_name() -> &'static str { "documents" }
        fn fields_metadata() -> Vec<FieldMetadata> {
            vec![
                FieldMetadata { name: "id".to_string(), datatype: "TEXT".to_string(), primary_key: true, unique: true, index: true },
                FieldMetadata { name: "text".to_string(), datatype: "TEXT".to_string(), primary_key: false, unique: false, index: false },
                FieldMetadata { name: "vector_val".to_string(), datatype: "BLOB".to_string(), primary_key: false, unique: false, index: false },
            ]
        }
        fn to_map(&self) -> HashMap<String, Value> {
            let mut m = HashMap::new();
            m.insert("id".to_string(), Value::Text(self.id.clone()));
            m.insert("text".to_string(), Value::Text(self.text.clone()));
            m.insert("vector_val".to_string(), Value::Blob(self.vector_val.clone()));
            m
        }
        fn from_map(mut map: HashMap<String, Value>) -> Self {
            let id = match map.remove("id").unwrap_or(Value::Null) { Value::Text(s) => s, _ => "".to_string() };
            let text = match map.remove("text").unwrap_or(Value::Null) { Value::Text(s) => s, _ => "".to_string() };
            let vector_val = match map.remove("vector_val").unwrap_or(Value::Null) { Value::Blob(b) => b, _ => Vec::new() };
            Document { id, text, vector_val }
        }
    }

    let mut mig = MigrationEngine::new(&mdb);
    mig.register_model::<Document>();
    mig.generate_and_apply_schema::<Document>().unwrap();

    let pipeline = ai::RAGPipeline::<Document>::new(&mdb, "vector_val", "text");
    let inserted = pipeline.ingest_document("This is a rust RAG pipeline example document.", HashMap::new()).unwrap();
    assert!(!inserted.is_empty());

    let results = pipeline.query_similarity("RAG pipeline", 1).unwrap();
    assert!(!results.is_empty());
}

#[test]
fn test_rust_performance_and_telemetry() {
    performance::cache_set("cache_key", "cached_value", Duration::from_millis(500));
    
    let val = performance::cache_get("cache_key").unwrap();
    assert_eq!(val, "cached_value");

    std::thread::sleep(Duration::from_millis(600));
    assert!(performance::cache_get("cache_key").is_none());

    observability::increment_metric("rust_tests_run");
    assert_eq!(observability::get_metric("rust_tests_run"), 1);
}

#[test]
fn test_rust_sqlite_auto_creation() {
    use std::time::SystemTime;
    let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs();
    let path = std::env::temp_dir().join(format!("bulldb_rust_test_{}", now));
    let db_file = path.join("nested").join("subdir").join("test.db");
    let db_url = format!("sqlite://{}", db_file.to_str().unwrap());

    let mdb = MultiDatabase::new();
    mdb.drivers.lock().unwrap().insert(
        "sqlite_file".to_string(),
        Box::new(bulldb::SQLiteMockDriver::new(
            "sqlite_file".to_string(),
            db_url,
        )),
    );

    let mut m = mdb.drivers.lock().unwrap();
    let driver = m.get_mut("sqlite_file").unwrap();
    driver.connect().unwrap();

    assert!(db_file.exists());
    assert!(db_file.parent().unwrap().exists());

    let _ = std::fs::remove_dir_all(path);
}

