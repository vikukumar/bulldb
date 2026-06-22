use std::collections::HashMap;
use std::sync::OnceLock;
use std::sync::Mutex;
use std::cell::RefCell;
use std::env;
use aes_gcm::{
    aead::{Aead, KeyInit, OsRng, AeadCore},
    Aes256Gcm
};
use pbkdf2::pbkdf2_hmac;
use sha2::{Sha256, Digest};
use base64::Engine;

pub struct SecurityEngine;

impl SecurityEngine {
    pub fn scan_sql_injection(input: &str) -> Result<(), String> {
        let pattern = ["UNION SELECT", "INSERT INTO", "DELETE FROM", "DROP TABLE", "UPDATE", "--", "/*"];
        let upper = input.to_uppercase();
        for p in pattern {
            if upper.contains(p) {
                return Err("malicious SQL input detected".to_string());
            }
        }
        Ok(())
    }
}

// Simple SQL injection checker helper
pub fn safe_sql(query: &str) -> Result<String, String> {
    SecurityEngine::scan_sql_injection(query)?;
    Ok(query.to_string())
}

// RLS Registry
pub type RLSRule = fn(user_id: &str, row: &HashMap<String, crate::Value>) -> bool;

static RLS_RULES: OnceLock<Mutex<HashMap<String, RLSRule>>> = OnceLock::new();

fn get_rls_rules() -> &'static Mutex<HashMap<String, RLSRule>> {
    RLS_RULES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn register_rls_rule(table: &str, rule: RLSRule) {
    let mut rules = get_rls_rules().lock().unwrap();
    rules.insert(table.to_string(), rule);
}

pub fn apply_rls_rules(table: &str, user_id: &str, rows: Vec<HashMap<String, crate::Value>>) -> Vec<HashMap<String, crate::Value>> {
    let rules = get_rls_rules().lock().unwrap();
    if let Some(&rule) = rules.get(table) {
        rows.into_iter().filter(|r| rule(user_id, r)).collect()
    } else {
        rows
    }
}

static CUSTOM_KEY: OnceLock<Mutex<Option<[u8; 32]>>> = OnceLock::new();

fn get_custom_key_store() -> &'static Mutex<Option<[u8; 32]>> {
    CUSTOM_KEY.get_or_init(|| Mutex::new(None))
}

pub fn set_encryption_key(key: Vec<u8>) {
    let mut store = get_custom_key_store().lock().unwrap();
    let mut key_32 = [0u8; 32];
    if key.len() >= 32 {
        key_32.copy_from_slice(&key[..32]);
    } else {
        let mut padded = vec![0u8; 32];
        padded[..key.len()].copy_from_slice(&key);
        key_32.copy_from_slice(&padded);
    }
    *store = Some(key_32);
}

static DEFAULT_KEY: OnceLock<[u8; 32]> = OnceLock::new();

fn get_encryption_key() -> [u8; 32] {
    {
        let store = get_custom_key_store().lock().unwrap();
        if let Some(key) = *store {
            return key;
        }
    }
    *DEFAULT_KEY.get_or_init(|| {
        if let Ok(key_str) = env::var("BULLDB_ENCRYPTION_KEY") {
            let mut hasher = Sha256::new();
            hasher.update(key_str.as_bytes());
            let result = hasher.finalize();
            let mut key = [0u8; 32];
            key.copy_from_slice(&result);
            key
        } else {
            let mut key = [0u8; 32];
            use rand::RngCore;
            rand::thread_rng().fill_bytes(&mut key);
            key
        }
    })
}

pub fn encrypt_field(plaintext: &str) -> String {
    if plaintext.is_empty() {
        return plaintext.to_string();
    }
    let key_bytes = get_encryption_key();
    let key = aes_gcm::Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);

    if let Ok(ciphertext) = cipher.encrypt(&nonce, plaintext.as_bytes()) {
        if ciphertext.len() >= 16 {
            let tag = &ciphertext[ciphertext.len() - 16..];
            let actual_ciphertext = &ciphertext[..ciphertext.len() - 16];
            let mut combined = Vec::new();
            combined.extend_from_slice(&nonce);
            combined.extend_from_slice(tag);
            combined.extend_from_slice(actual_ciphertext);
            return base64::engine::general_purpose::STANDARD.encode(combined);
        }
    }
    plaintext.to_string()
}

pub fn decrypt_field(ciphertext_b64: &str) -> String {
    if ciphertext_b64.is_empty() {
        return ciphertext_b64.to_string();
    }
    if let Ok(combined) = base64::engine::general_purpose::STANDARD.decode(ciphertext_b64) {
        if combined.len() < 28 {
            return ciphertext_b64.to_string();
        }
        let nonce = &combined[..12];
        let tag = &combined[12..28];
        let actual_ciphertext = &combined[28..];

        let mut seal_input = Vec::new();
        seal_input.extend_from_slice(actual_ciphertext);
        seal_input.extend_from_slice(tag);

        let key_bytes = get_encryption_key();
        let key = aes_gcm::Key::<Aes256Gcm>::from_slice(&key_bytes);
        let cipher = Aes256Gcm::new(key);
        let nonce_ref = aes_gcm::Nonce::from_slice(nonce);

        if let Ok(plaintext) = cipher.decrypt(nonce_ref, seal_input.as_slice()) {
            if let Ok(decrypted) = String::from_utf8(plaintext) {
                return decrypted;
            }
        }
    }
    ciphertext_b64.to_string()
}

// PBKDF2 Password Hashing Functions
pub fn hash_password(password: &str) -> String {
    let mut salt = [0u8; 16];
    let mut key = [0u8; 32];
    rand::thread_rng(); // initialize rand crate
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut salt);
    let iterations = 100000;
    
    pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, iterations, &mut key);

    let salt_b64 = base64::engine::general_purpose::STANDARD.encode(salt);
    let key_b64 = base64::engine::general_purpose::STANDARD.encode(key);
    format!("{}${}${}", iterations, salt_b64, key_b64)
}

pub fn verify_password(password: &str, hashed: &str) -> bool {
    let parts: Vec<&str> = hashed.split('$').collect();
    if parts.len() != 3 {
        return false;
    }
    let iterations: u32 = match parts[0].parse() {
        Ok(it) => it,
        Err(_) => return false,
    };
    let salt = match base64::engine::general_purpose::STANDARD.decode(parts[1]) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let stored_key = match base64::engine::general_purpose::STANDARD.decode(parts[2]) {
        Ok(k) => k,
        Err(_) => return false,
    };

    let mut computed_key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, iterations, &mut computed_key);
    computed_key == stored_key.as_slice()
}

// Session Context (Thread-local)
#[derive(Debug, Clone, Default)]
pub struct SessionContext {
    pub tenant_id: Option<String>,
    pub user_id: Option<String>,
    pub roles: Vec<String>,
}

thread_local! {
    static SESSION_CONTEXT: RefCell<SessionContext> = RefCell::new(SessionContext::default());
}

pub fn set_session_context(tenant_id: Option<String>, user_id: Option<String>, roles: Vec<String>) {
    SESSION_CONTEXT.with(|ctx| {
        *ctx.borrow_mut() = SessionContext {
            tenant_id,
            user_id,
            roles,
        };
    });
}

pub fn get_session_context() -> SessionContext {
    SESSION_CONTEXT.with(|ctx| ctx.borrow().clone())
}

pub fn clear_session_context() {
    SESSION_CONTEXT.with(|ctx| {
        *ctx.borrow_mut() = SessionContext::default();
    });
}

// RLS AST Injection
pub fn inject_rls(wheres: &mut Vec<String>, args: &mut Vec<crate::Value>) {
    let ctx = get_session_context();
    if let Some(tenant_id) = ctx.tenant_id {
        wheres.push("tenant_id = ?".to_string());
        args.push(crate::Value::Text(tenant_id));
    }
}
