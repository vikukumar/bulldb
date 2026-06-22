import * as crypto from "crypto";

export class AIEngine {
  private static embeddingCache = new Map<string, number[]>();

  static async generateEmbeddings(text: string, provider = "openai"): Promise<number[]> {
    const cleaned = text.replace(/\n/g, " ").trim();
    if (!cleaned) return new Array(1536).fill(0);

    if (this.embeddingCache.has(cleaned)) {
      return this.embeddingCache.get(cleaned)!;
    }

    const openAiKey = process.env.OPENAI_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;
    const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";

    try {
      // Best effort dynamic fetch for node runtime if API keys exist
      if (provider === "openai" && openAiKey) {
        const response = await fetch("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${openAiKey}`
          },
          body: JSON.stringify({
            input: cleaned,
            model: "text-embedding-3-small"
          })
        });
        const json = (await response.json()) as any;
        const vector = json.data[0].embedding;
        this.embeddingCache.set(cleaned, vector);
        return vector;
      } else if (provider === "gemini" && geminiKey) {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${geminiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: { parts: [{ text: cleaned }] }
          })
        });
        const json = (await response.json()) as any;
        const vector = json.embedding.values;
        this.embeddingCache.set(cleaned, vector);
        return vector;
      } else if (provider === "ollama") {
        const response = await fetch(`${ollamaUrl}/api/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "nomic-embed-text",
            prompt: cleaned
          })
        });
        const json = (await response.json()) as any;
        const vector = json.embedding;
        this.embeddingCache.set(cleaned, vector);
        return vector;
      }
    } catch (err) {
      return this.generateMockVector(cleaned);
    }

    return this.generateMockVector(cleaned);
  }

  private static generateMockVector(text: string, dimension = 1536): number[] {
    const hash = crypto.createHash("sha256").update(text).digest();
    const vector: number[] = [];
    for (let i = 0; i < dimension; i++) {
      const byteIdx = (i * 7) % hash.length;
      const weight = (hash[byteIdx] / 255.0) - 0.5;
      vector.push(weight);
    }

    // L2 Normalize
    const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    if (norm > 0) {
      return vector.map((val) => val / norm);
    }
    return vector;
  }
}

export class TextChunker {
  static chunkText(text: string, chunkSize = 500, chunkOverlap = 50): string[] {
    if (!text) return [];
    const words = text.split(/\s+/);
    const chunks: string[] = [];
    let i = 0;
    while (i < words.length) {
      const chunkWords = words.slice(i, i + chunkSize);
      chunks.push(chunkWords.join(" "));
      i += (chunkSize - chunkOverlap);
      if (i <= 0) break;
    }
    return chunks;
  }
}

export class RAGPipeline {
  constructor(
    private modelClass: any,
    private embeddingField: string,
    private textField: string
  ) {}

  async ingestDocument(text: string, extraMeta?: Record<string, any>): Promise<any[]> {
    const chunks = TextChunker.chunkText(text);
    const inserted: any[] = [];
    for (const chunk of chunks) {
      const payload = {
        [this.textField]: chunk,
        ...extraMeta
      };
      const instance = new this.modelClass(payload);
      await instance.save();
      inserted.push(instance);
    }
    return inserted;
  }

  async querySimilarity(queryText: string, limit = 5): Promise<any[]> {
    const queryVector = await AIEngine.generateEmbeddings(queryText);
    return this.modelClass.find()
      .vectorSearch(this.embeddingField, queryVector, limit)
      .execute();
  }
}
