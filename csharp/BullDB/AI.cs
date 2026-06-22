using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;

namespace BullDB
{
    public static class AIEngine
    {
        private static readonly Dictionary<string, double[]> EmbeddingCache = new Dictionary<string, double[]>();
        private static readonly object CacheLock = new object();

        private static readonly System.Net.Http.HttpClient HttpClient = new System.Net.Http.HttpClient { Timeout = TimeSpan.FromSeconds(10) };

        public static async Task<double[]> GenerateEmbeddingsAsync(string text, string provider = "openai")
        {
            var cleaned = text.Replace("\n", " ").Trim();
            if (string.IsNullOrEmpty(cleaned)) return new double[1536];

            lock (CacheLock)
            {
                if (EmbeddingCache.TryGetValue(cleaned, out var cached)) return cached;
            }

            double[] vector = null;

            var openAiKey = Environment.GetEnvironmentVariable("OPENAI_API_KEY") ?? "";
            var geminiKey = Environment.GetEnvironmentVariable("GEMINI_API_KEY") ?? "";
            var ollamaUrl = Environment.GetEnvironmentVariable("OLLAMA_URL") ?? "http://localhost:11434";

            try
            {
                if (provider == "openai" && !string.IsNullOrEmpty(openAiKey))
                {
                    vector = await FetchOpenAIEmbeddingsAsync(cleaned, openAiKey);
                }
                else if (provider == "gemini" && !string.IsNullOrEmpty(geminiKey))
                {
                    vector = await FetchGeminiEmbeddingsAsync(cleaned, geminiKey);
                }
                else if (provider == "ollama")
                {
                    vector = await FetchOllamaEmbeddingsAsync(cleaned, ollamaUrl);
                }
            }
            catch
            {
                // Fallback to mock
            }

            if (vector == null)
            {
                vector = GenerateMockVector(cleaned);
            }

            lock (CacheLock)
            {
                EmbeddingCache[cleaned] = vector;
            }

            return vector;
        }

        private static async Task<double[]> FetchOpenAIEmbeddingsAsync(string text, string apiKey)
        {
            var requestBody = System.Text.Json.JsonSerializer.Serialize(new
            {
                input = text,
                model = "text-embedding-3-small"
            });

            using (var request = new System.Net.Http.HttpRequestMessage(System.Net.Http.HttpMethod.Post, "https://api.openai.com/v1/embeddings"))
            {
                request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", apiKey);
                request.Content = new System.Net.Http.StringContent(requestBody, Encoding.UTF8, "application/json");

                using (var response = await HttpClient.SendAsync(request))
                {
                    response.EnsureSuccessStatusCode();
                    var content = await response.Content.ReadAsStringAsync();
                    using (var doc = System.Text.Json.JsonDocument.Parse(content))
                    {
                        var dataNode = doc.RootElement.GetProperty("data")[0];
                        var embeddingNode = dataNode.GetProperty("embedding");
                        var result = new double[embeddingNode.GetArrayLength()];
                        for (int i = 0; i < result.Length; i++)
                        {
                            result[i] = embeddingNode[i].GetDouble();
                        }
                        return result;
                    }
                }
            }
        }

        private static async Task<double[]> FetchGeminiEmbeddingsAsync(string text, string apiKey)
        {
            var requestBody = System.Text.Json.JsonSerializer.Serialize(new
            {
                content = new
                {
                    parts = new[]
                    {
                        new { text = text }
                    }
                }
            });

            var url = $"https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key={apiKey}";
            using (var content = new System.Net.Http.StringContent(requestBody, Encoding.UTF8, "application/json"))
            {
                using (var response = await HttpClient.PostAsync(url, content))
                {
                    response.EnsureSuccessStatusCode();
                    var resStr = await response.Content.ReadAsStringAsync();
                    using (var doc = System.Text.Json.JsonDocument.Parse(resStr))
                    {
                        var embeddingNode = doc.RootElement.GetProperty("embedding").GetProperty("values");
                        var result = new double[embeddingNode.GetArrayLength()];
                        for (int i = 0; i < result.Length; i++)
                        {
                            result[i] = embeddingNode[i].GetDouble();
                        }
                        return result;
                    }
                }
            }
        }

        private static async Task<double[]> FetchOllamaEmbeddingsAsync(string text, string ollamaUrl)
        {
            var requestBody = System.Text.Json.JsonSerializer.Serialize(new
            {
                model = "nomic-embed-text",
                prompt = text
            });

            var url = $"{ollamaUrl.TrimEnd('/')}/api/embeddings";
            using (var content = new System.Net.Http.StringContent(requestBody, Encoding.UTF8, "application/json"))
            {
                using (var response = await HttpClient.PostAsync(url, content))
                {
                    response.EnsureSuccessStatusCode();
                    var resStr = await response.Content.ReadAsStringAsync();
                    using (var doc = System.Text.Json.JsonDocument.Parse(resStr))
                    {
                        var embeddingNode = doc.RootElement.GetProperty("embedding");
                        var result = new double[embeddingNode.GetArrayLength()];
                        for (int i = 0; i < result.Length; i++)
                        {
                            result[i] = embeddingNode[i].GetDouble();
                        }
                        return result;
                    }
                }
            }
        }

        private static double[] GenerateMockVector(string text)
        {
            byte[] hash;
            using (var sha = SHA256.Create())
            {
                hash = sha.ComputeHash(Encoding.UTF8.GetBytes(text));
            }

            var vector = new double[1536];
            for (int i = 0; i < 1536; i++)
            {
                int byteIdx = (i * 7) % hash.Length;
                double weight = (hash[byteIdx] / 255.0) - 0.5;
                vector[i] = weight;
            }

            // L2 Normalize
            double sumSquares = 0;
            for (int i = 0; i < 1536; i++)
            {
                sumSquares += vector[i] * vector[i];
            }
            double norm = Math.Sqrt(sumSquares);
            if (norm > 0)
            {
                for (int i = 0; i < 1536; i++)
                {
                    vector[i] /= norm;
                }
            }

            return vector;
        }

        public static double CosineSimilarity(double[] a, double[] b)
        {
            if (a.Length != b.Length || a.Length == 0)
            {
                throw new ArgumentException("vectors must have identical positive length");
            }

            double dot = 0;
            double normA = 0;
            double normB = 0;

            for (int i = 0; i < a.Length; i++)
            {
                dot += a[i] * b[i];
                normA += a[i] * a[i];
                normB += b[i] * b[i];
            }

            if (normA == 0 || normB == 0) return 0.0;

            return dot / (Math.Sqrt(normA) * Math.Sqrt(normB));
        }
    }

    public static class TextChunker
    {
        public static List<string> ChunkText(string text, int chunkSize = 500, int chunkOverlap = 50)
        {
            if (string.IsNullOrEmpty(text)) return new List<string>();
            var words = text.Split(new[] { ' ', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            if (words.Length == 0) return new List<string>();

            var chunks = new List<string>();
            int i = 0;
            while (i < words.Length)
            {
                int end = Math.Min(i + chunkSize, words.Length);
                var chunk = string.Join(" ", words, i, end - i);
                chunks.Add(chunk);
                if (end == words.Length) break;
                if (chunkSize <= chunkOverlap) break; // prevent infinite loop
                i += chunkSize - chunkOverlap;
            }
            return chunks;
        }
    }

    // RAG Pipeline
    public class RAGPipeline<T> where T : BaseModel, new()
    {
        private readonly MultiDatabase _db;
        private readonly string _embeddingField;
        private readonly string _textField;

        public RAGPipeline(MultiDatabase db, string embeddingField, string textField)
        {
            _db = db;
            _embeddingField = embeddingField;
            _textField = textField;
        }

        public async Task<List<T>> IngestDocumentAsync(string text, Dictionary<string, object>? extraMeta = null)
        {
            var chunks = TextChunker.ChunkText(text, 500, 50);
            var inserted = new List<T>();

            foreach (var chunk in chunks)
            {
                var item = new T();
                var type = typeof(T);

                // Set text field
                var textProp = type.GetProperty(_textField, System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.IgnoreCase);
                textProp?.SetValue(item, chunk);

                // Set embedding field
                var vector = await AIEngine.GenerateEmbeddingsAsync(chunk, "openai");
                var embProp = type.GetProperty(_embeddingField, System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.IgnoreCase);

                if (embProp != null)
                {
                    if (embProp.PropertyType == typeof(double[]))
                    {
                        embProp.SetValue(item, vector);
                    }
                    else if (embProp.PropertyType == typeof(byte[]))
                    {
                        var bytes = new byte[vector.Length * 8];
                        Buffer.BlockCopy(vector, 0, bytes, 0, bytes.Length);
                        embProp.SetValue(item, bytes);
                    }
                }

                // Set extraMeta fields
                if (extraMeta != null)
                {
                    foreach (var kv in extraMeta)
                    {
                        var prop = type.GetProperty(kv.Key, System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.IgnoreCase);
                        prop?.SetValue(item, kv.Value);
                    }
                }

                await item.SaveAsync();
                inserted.Add(item);
            }

            return inserted;
        }

        public async Task<List<T>> QuerySimilarityAsync(string queryText, int limit = 5)
        {
            var vector = await AIEngine.GenerateEmbeddingsAsync(queryText, "openai");
            var qb = new QueryBuilder<T>();
            qb.VectorSearch(_embeddingField, vector, limit);

            return await qb.ExecuteAsync();
        }
    }
}
