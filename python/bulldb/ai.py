import os
from typing import List, Dict, Any, Optional
import httpx

class AIEngine:
    _embedding_cache: Dict[str, List[float]] = {}

    @classmethod
    async def generate_embeddings(cls, text: str, provider: str = "openai") -> List[float]:
        # Clean string
        text = text.replace("\n", " ").strip()
        if not text:
            return [0.0] * 1536

        # Check Cache
        if text in cls._embedding_cache:
            return cls._embedding_cache[text]

        # Call remote API or trigger local/mock fallback
        api_key = os.getenv("OPENAI_API_KEY")
        gemini_key = os.getenv("GEMINI_API_KEY")
        ollama_url = os.getenv("OLLAMA_URL", "http://localhost:11434")

        try:
            if provider == "openai" and api_key:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    resp = await client.post(
                        "https://api.openai.com/v1/embeddings",
                        headers={"Authorization": f"Bearer {api_key}"},
                        json={"input": text, "model": "text-embedding-3-small"}
                    )
                    resp.raise_for_status()
                    vector = resp.json()["data"][0]["embedding"]
                    cls._embedding_cache[text] = vector
                    return vector
            elif provider == "gemini" and gemini_key:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    resp = await client.post(
                        f"https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key={gemini_key}",
                        json={"content": {"parts": [{"text": text}]}}
                    )
                    resp.raise_for_status()
                    vector = resp.json()["embedding"]["values"]
                    cls._embedding_cache[text] = vector
                    return vector
            elif provider == "ollama":
                async with httpx.AsyncClient(timeout=10.0) as client:
                    resp = await client.post(
                        f"{ollama_url}/api/embeddings",
                        json={"model": "nomic-embed-text", "prompt": text}
                    )
                    resp.raise_for_status()
                    vector = resp.json()["embedding"]
                    cls._embedding_cache[text] = vector
                    return vector
        except Exception:
            # Fallback embedding generation using hash weights (deterministic, zero-dependency)
            return cls._generate_mock_vector(text)

        return cls._generate_mock_vector(text)

    @classmethod
    def _generate_mock_vector(cls, text: str, dimension: int = 1536) -> List[float]:
        # Generate pseudo-random deterministic vector based on text characters
        import hashlib
        h = hashlib.sha256(text.encode("utf-8")).digest()
        vector = []
        for i in range(dimension):
            byte_idx = (i * 7) % len(h)
            weight = (h[byte_idx] / 255.0) - 0.5
            vector.append(weight)
        
        # L2 Normalize
        import math
        norm = math.sqrt(sum(x*x for x in vector))
        if norm > 0:
            vector = [x / norm for x in vector]
        return vector

class TextChunker:
    @staticmethod
    def chunk_text(text: str, chunk_size: int = 500, chunk_overlap: int = 50) -> List[str]:
        if not text:
            return []
        
        words = text.split()
        chunks = []
        i = 0
        while i < len(words):
            chunk_words = words[i : i + chunk_size]
            chunks.append(" ".join(chunk_words))
            i += (chunk_size - chunk_overlap)
            if i <= 0:
                break
        return chunks

class RAGPipeline:
    def __init__(self, model_class: Any, embedding_field: str, text_field: str):
        self.model_class = model_class
        self.embedding_field = embedding_field
        self.text_field = text_field

    async def ingest_document(self, text: str, extra_meta: Optional[dict] = None) -> Any:
        chunks = TextChunker.chunk_text(text)
        inserted_instances = []
        for chunk in chunks:
            payload = {self.text_field: chunk}
            if extra_meta:
                payload.update(extra_meta)
            
            # create and save model (triggers auto-embedding generation hook)
            instance = self.model_class(**payload)
            await instance.save()
            inserted_instances.append(instance)
        return inserted_instances

    async def query_similarity(self, query_text: str, limit: int = 5) -> List[Any]:
        # 1. Generate query embedding
        query_vector = await AIEngine.generate_embeddings(query_text)
        # 2. Query builder vector search
        return await self.model_class.find().vector_search(self.embedding_field, query_vector, limit).execute()
