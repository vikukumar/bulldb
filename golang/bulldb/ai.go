package bulldb

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"reflect"
	"strings"
	"sync"
	"time"
)

type AIEngine struct{}

var (
	embeddingCache = make(map[string][]float64)
	cacheMu        sync.RWMutex
	httpClient     = &http.Client{Timeout: 10 * time.Second}
)

func (AIEngine) GenerateEmbeddings(text string, provider string) ([]float64, error) {
	cleaned := strings.ReplaceAll(text, "\n", " ")
	cleaned = strings.TrimSpace(cleaned)
	if cleaned == "" {
		return make([]float64, 1536), nil
	}

	// Check cache
	cacheMu.RLock()
	cached, found := embeddingCache[cleaned]
	cacheMu.RUnlock()
	if found {
		return cached, nil
	}

	openAiKey := os.Getenv("OPENAI_API_KEY")
	geminiKey := os.Getenv("GEMINI_API_KEY")
	ollamaUrl := os.Getenv("OLLAMA_URL")
	if ollamaUrl == "" {
		ollamaUrl = "http://localhost:11434"
	}

	var vector []float64
	var err error

	// Try API calls
	if provider == "openai" && openAiKey != "" {
		vector, err = fetchOpenAIEmbeddings(cleaned, openAiKey)
	} else if provider == "gemini" && geminiKey != "" {
		vector, err = fetchGeminiEmbeddings(cleaned, geminiKey)
	} else if provider == "ollama" {
		vector, err = fetchOllamaEmbeddings(cleaned, ollamaUrl)
	}

	// Fallback to mock normalized vector if any error occurs or keys are missing
	if err != nil || len(vector) == 0 {
		vector = generateMockVector(cleaned)
	}

	// Cache the result
	cacheMu.Lock()
	embeddingCache[cleaned] = vector
	cacheMu.Unlock()

	return vector, nil
}

func fetchOpenAIEmbeddings(text, apiKey string) ([]float64, error) {
	reqBody, _ := json.Marshal(map[string]interface{}{
		"input": text,
		"model": "text-embedding-3-small",
	})
	req, _ := http.NewRequest("POST", "https://api.openai.com/v1/embeddings", bytes.NewBuffer(reqBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("non-200 status code from OpenAI")
	}

	var result struct {
		Data []struct {
			Embedding []float64 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	if len(result.Data) == 0 {
		return nil, errors.New("no embedding returned")
	}
	return result.Data[0].Embedding, nil
}

func fetchGeminiEmbeddings(text, apiKey string) ([]float64, error) {
	reqBody, _ := json.Marshal(map[string]interface{}{
		"content": map[string]interface{}{
			"parts": []interface{}{
				map[string]string{"text": text},
			},
		},
	})
	url := fmt.Sprintf("https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=%s", apiKey)
	req, _ := http.NewRequest("POST", url, bytes.NewBuffer(reqBody))
	req.Header.Set("Content-Type", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("non-200 status code from Gemini")
	}

	var result struct {
		Embedding struct {
			Values []float64 `json:"values"`
		} `json:"embedding"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	return result.Embedding.Values, nil
}

func fetchOllamaEmbeddings(text, url string) ([]float64, error) {
	reqBody, _ := json.Marshal(map[string]interface{}{
		"model":  "nomic-embed-text",
		"prompt": text,
	})
	req, _ := http.NewRequest("POST", url+"/api/embeddings", bytes.NewBuffer(reqBody))
	req.Header.Set("Content-Type", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("non-200 status code from Ollama")
	}

	var result struct {
		Embedding []float64 `json:"embedding"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	return result.Embedding, nil
}

func generateMockVector(text string) []float64 {
	hash := sha256.Sum256([]byte(text))
	vector := make([]float64, 1536)
	for i := 0; i < 1536; i++ {
		byteIdx := (i * 7) % len(hash)
		weight := (float64(hash[byteIdx]) / 255.0) - 0.5
		vector[i] = weight
	}

	// L2 Normalize
	var sumSquares float64
	for _, val := range vector {
		sumSquares += val * val
	}
	norm := math.Sqrt(sumSquares)
	if norm > 0 {
		for i := range vector {
			vector[i] /= norm
		}
	}
	return vector
}

func (AIEngine) CosineSimilarity(a, b []float64) (float64, error) {
	if len(a) != len(b) || len(a) == 0 {
		return 0, errors.New("vectors must have identical positive length")
	}

	var dot, normA, normB float64
	for i := range a {
		dot += a[i] * b[i]
		normA += a[i] * a[i]
		normB += b[i] * b[i]
	}

	if normA == 0 || normB == 0 {
		return 0, nil
	}

	return dot / (math.Sqrt(normA) * math.Sqrt(normB)), nil
}

// Text Chunker
type TextChunker struct{}

func (TextChunker) ChunkText(text string, chunkSize int, chunkOverlap int) []string {
	words := strings.Fields(text)
	if len(words) == 0 {
		return []string{}
	}

	var chunks []string
	i := 0
	for i < len(words) {
		end := i + chunkSize
		if end > len(words) {
			end = len(words)
		}
		chunk := strings.Join(words[i:end], " ")
		chunks = append(chunks, chunk)
		if end == len(words) {
			break
		}
		i += (chunkSize - chunkOverlap)
		if chunkSize <= chunkOverlap {
			break // prevent infinite loop
		}
	}
	return chunks
}

// RAG Pipeline
type RAGPipeline struct {
	modelPrototype interface{}
	embeddingField string
	textField      string
}

func NewRAGPipeline(modelPrototype interface{}, embeddingField, textField string) *RAGPipeline {
	return &RAGPipeline{
		modelPrototype: modelPrototype,
		embeddingField: embeddingField,
		textField:      textField,
	}
}

func (p *RAGPipeline) IngestDocument(ctx context.Context, text string, extraMeta map[string]interface{}) ([]interface{}, error) {
	chunks := TextChunker{}.ChunkText(text, 500, 50)
	var inserted []interface{}
	for _, chunk := range chunks {
		t := reflect.TypeOf(p.modelPrototype)
		if t.Kind() == reflect.Ptr {
			t = t.Elem()
		}
		newVal := reflect.New(t)
		elem := newVal.Elem()

		foundText := false
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			dbTag := f.Tag.Get("db")
			colName := strings.Split(dbTag, ",")[0]
			if colName == p.textField {
				elem.Field(i).SetString(chunk)
				foundText = true
			}
			if extraMeta != nil {
				if metaVal, exists := extraMeta[colName]; exists {
					valRef := reflect.ValueOf(metaVal)
					if valRef.Type().ConvertibleTo(elem.Field(i).Type()) {
						elem.Field(i).Set(valRef.Convert(elem.Field(i).Type()))
					}
				}
			}
		}

		if !foundText {
			return nil, fmt.Errorf("text field %s not found on model struct", p.textField)
		}

		err := Create(ctx, newVal.Interface())
		if err != nil {
			return nil, err
		}
		inserted = append(inserted, newVal.Interface())
	}
	return inserted, nil
}

func (p *RAGPipeline) QuerySimilarity(ctx context.Context, queryText string, limit int, dest interface{}) error {
	vec, err := AIEngine{}.GenerateEmbeddings(queryText, "openai")
	if err != nil {
		return err
	}

	t := reflect.TypeOf(p.modelPrototype)
	if t.Kind() == reflect.Ptr {
		t = t.Elem()
	}
	tableName := strings.ToLower(t.Name()) + "s"

	qb := NewQueryBuilder(tableName)
	qb.VectorSearch(p.embeddingField, vec, limit)

	return qb.Find(ctx, dest)
}
