use std::collections::HashMap;
use std::sync::{OnceLock, Mutex};
use std::env;
use sha2::{Sha256, Digest};
use crate::Model;

pub struct AIEngine;

static EMBEDDING_CACHE: OnceLock<Mutex<HashMap<String, Vec<f64>>>> = OnceLock::new();

fn get_embedding_cache() -> &'static Mutex<HashMap<String, Vec<f64>>> {
    EMBEDDING_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

impl AIEngine {
    pub fn generate_embeddings(text: &str, provider: &str) -> Result<Vec<f64>, String> {
        let cleaned = text.replace('\n', " ").trim().to_string();
        if cleaned.is_empty() {
            return Ok(vec![0.0; 1536]);
        }

        // Check Cache
        {
            let cache = get_embedding_cache().lock().unwrap();
            if let Some(vector) = cache.get(&cleaned) {
                return Ok(vector.clone());
            }
        }

        let open_ai_key = env::var("OPENAI_API_KEY").unwrap_or_default();
        let gemini_key = env::var("GEMINI_API_KEY").unwrap_or_default();
        let ollama_url = env::var("OLLAMA_URL").unwrap_or_else(|_| "http://localhost:11434".to_string());

        let mut vector = None;

        if provider == "openai" && !open_ai_key.is_empty() {
            if let Ok(vec) = Self::fetch_openai_embeddings(&cleaned, &open_ai_key) {
                vector = Some(vec);
            }
        } else if provider == "gemini" && !gemini_key.is_empty() {
            if let Ok(vec) = Self::fetch_gemini_embeddings(&cleaned, &gemini_key) {
                vector = Some(vec);
            }
        } else if provider == "ollama" && !ollama_url.is_empty() {
            if let Ok(vec) = Self::fetch_ollama_embeddings(&cleaned, &ollama_url) {
                vector = Some(vec);
            }
        }

        let final_vector = vector.unwrap_or_else(|| Self::generate_mock_vector(&cleaned));

        // Cache result
        {
            let mut cache = get_embedding_cache().lock().unwrap();
            cache.insert(cleaned, final_vector.clone());
        }

        Ok(final_vector)
    }

    fn fetch_openai_embeddings(text: &str, api_key: &str) -> Result<Vec<f64>, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| e.to_string())?;
        
        let body = serde_json::json!({
            "input": text,
            "model": "text-embedding-3-small"
        });

        let resp = client.post("https://api.openai.com/v1/embeddings")
            .header("Authorization", format!("Bearer {}", api_key))
            .json(&body)
            .send()
            .map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            return Err(format!("OpenAI returned status: {}", resp.status()));
        }

        let res_json: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
        let vector = res_json["data"][0]["embedding"]
            .as_array()
            .ok_or("No embedding data found in response")?
            .iter()
            .map(|v| v.as_f64().unwrap_or(0.0))
            .collect();
        Ok(vector)
    }

    fn fetch_gemini_embeddings(text: &str, api_key: &str) -> Result<Vec<f64>, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| e.to_string())?;

        let body = serde_json::json!({
            "content": {
                "parts": [
                    { "text": text }
                ]
            }
        });

        let url = format!("https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key={}", api_key);
        let resp = client.post(&url)
            .json(&body)
            .send()
            .map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            return Err(format!("Gemini returned status: {}", resp.status()));
        }

        let res_json: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
        let vector = res_json["embedding"]["values"]
            .as_array()
            .ok_or("No embedding values found in response")?
            .iter()
            .map(|v| v.as_f64().unwrap_or(0.0))
            .collect();
        Ok(vector)
    }

    fn fetch_ollama_embeddings(text: &str, url: &str) -> Result<Vec<f64>, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| e.to_string())?;

        let body = serde_json::json!({
            "model": "nomic-embed-text",
            "prompt": text
        });

        let endpoint = format!("{}/api/embeddings", url);
        let resp = client.post(&endpoint)
            .json(&body)
            .send()
            .map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            return Err(format!("Ollama returned status: {}", resp.status()));
        }

        let res_json: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
        let vector = res_json["embedding"]
            .as_array()
            .ok_or("No embedding found in response")?
            .iter()
            .map(|v| v.as_f64().unwrap_or(0.0))
            .collect();
        Ok(vector)
    }

    fn generate_mock_vector(text: &str) -> Vec<f64> {
        let mut hasher = Sha256::new();
        hasher.update(text.as_bytes());
        let hash = hasher.finalize();

        let mut vector = vec![0.0; 1536];
        for i in 0..1536 {
            let byte_idx = (i * 7) % hash.len();
            let weight = (hash[byte_idx] as f64 / 255.0) - 0.5;
            vector[i] = weight;
        }

        // L2 Normalize
        let mut sum_squares = 0.0;
        for val in &vector {
            sum_squares += val * val;
        }
        let norm = sum_squares.sqrt();
        if norm > 0.0 {
            for val in &mut vector {
                *val /= norm;
            }
        }
        vector
    }

    pub fn cosine_similarity(a: &[f64], b: &[f64]) -> Result<f64, String> {
        if a.len() != b.len() || a.is_empty() {
            return Err("vectors must have identical positive length".to_string());
        }

        let mut dot = 0.0;
        let mut norm_a = 0.0;
        let mut norm_b = 0.0;

        for i in 0..a.len() {
            dot += a[i] * b[i];
            norm_a += a[i] * a[i];
            norm_b += b[i] * b[i];
        }

        if norm_a == 0.0 || norm_b == 0.0 {
            return Ok(0.0);
        }

        Ok(dot / (norm_a.sqrt() * norm_b.sqrt()))
    }
}

pub struct TextChunker;

impl TextChunker {
    pub fn chunk_text(text: &str, chunk_size: usize, chunk_overlap: usize) -> Vec<String> {
        let words: Vec<&str> = text.split_whitespace().collect();
        if words.is_empty() {
            return Vec::new();
        }

        let mut chunks = Vec::new();
        let mut i = 0;
        while i < words.len() {
            let end = std::cmp::min(i + chunk_size, words.len());
            let chunk = words[i..end].join(" ");
            chunks.push(chunk);
            if end == words.len() {
                break;
            }
            if chunk_size <= chunk_overlap {
                break; // avoid infinite loop
            }
            i += chunk_size - chunk_overlap;
        }
        chunks
    }
}

// RAG Pipeline
pub struct RAGPipeline<'a, M: Model> {
    mdb: &'a crate::MultiDatabase,
    embedding_field: String,
    text_field: String,
    _marker: std::marker::PhantomData<M>,
}

impl<'a, M: Model> RAGPipeline<'a, M> {
    pub fn new(mdb: &'a crate::MultiDatabase, embedding_field: &str, text_field: &str) -> Self {
        Self {
            mdb,
            embedding_field: embedding_field.to_string(),
            text_field: text_field.to_string(),
            _marker: std::marker::PhantomData,
        }
    }

    pub fn ingest_document(&self, text: &str, extra_meta: HashMap<String, crate::Value>) -> Result<Vec<M>, String> {
        let chunks = TextChunker::chunk_text(text, 500, 50);
        let mut inserted = Vec::new();

        for chunk in chunks {
            let mut payload = HashMap::new();
            payload.insert(self.text_field.clone(), crate::Value::Text(chunk.clone()));

            for (k, v) in &extra_meta {
                payload.insert(k.clone(), v.clone());
            }

            if let Ok(vec) = AIEngine::generate_embeddings(&chunk, "openai") {
                let mut vec_bytes = Vec::new();
                for f in vec {
                    vec_bytes.extend_from_slice(&f.to_le_bytes());
                }
                payload.insert(self.embedding_field.clone(), crate::Value::Blob(vec_bytes));
            }

            if !payload.contains_key("id") {
                payload.insert("id".to_string(), crate::Value::Text(uuid_simple()));
            }

            let saved = self.mdb.write(M::table_name(), payload, true)?;
            inserted.push(M::from_map(saved));
        }

        Ok(inserted)
    }

    pub fn query_similarity(&self, query_text: &str, limit: usize) -> Result<Vec<M>, String> {
        let vec = AIEngine::generate_embeddings(query_text, "openai")?;
        let qb = crate::QueryBuilder::<M>::new(self.mdb).vector_search(&self.embedding_field, vec, limit);
        qb.execute()
    }
}

fn uuid_simple() -> String {
    let mut bytes = [0u8; 16];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5],
        bytes[6], bytes[7],
        bytes[8], bytes[9],
        bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}
