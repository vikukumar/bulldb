import time
import logging
from typing import Dict, Any, Optional

logger = logging.getLogger("bulldb.performance")

class LocalCache:
    def __init__(self):
        self.data: Dict[str, tuple] = {} # key -> (value, expiry)

    def get(self, key: str) -> Optional[Any]:
        if key in self.data:
            val, expiry = self.data[key]
            if time.time() < expiry:
                return val
            else:
                del self.data[key]
        return None

    def set(self, key: str, value: Any, ttl: int = 60):
        self.data[key] = (value, time.time() + ttl)

class RedisCache:
    def __init__(self, host: str = "localhost", port: int = 6379):
        self.host = host
        self.port = port
        self.client = None
        try:
            import redis
            self.client = redis.Redis(host=host, port=port, decode_responses=True)
        except ImportError:
            pass

    def get(self, key: str) -> Optional[Any]:
        if not self.client:
            return None
        import json
        val = self.client.get(key)
        if val:
            return json.loads(val)
        return None

    def set(self, key: str, value: Any, ttl: int = 60):
        if not self.client:
            return
        import json
        self.client.setex(key, ttl, json.dumps(value))

class N1QueryDetector:
    # Tracks query counts of relationships within short execution blocks
    _query_history: list = [] # list of (timestamp, query_sql)
    _threshold_seconds: float = 1.0
    _count_trigger: int = 5

    @classmethod
    def record_query(cls, sql: str):
        now = time.time()
        cls._query_history.append((now, sql))
        # Clean history
        cls._query_history = [item for item in cls._query_history if now - item[0] < cls._threshold_seconds]
        
        # Analyze signatures
        signatures = {}
        for _, q in cls._query_history:
            # abstract values out for fingerprinting
            fingerprint = cls._get_fingerprint(q)
            signatures[fingerprint] = signatures.get(fingerprint, 0) + 1

        for fp, count in signatures.items():
            if count >= cls._count_trigger:
                logger.warning(
                    f"[N+1 Query Detected] Query signature '{fp}' was executed {count} times in the last "
                    f"{cls._threshold_seconds}s. Consider using eager loading or relationship prefetching."
                )

    @classmethod
    def _get_fingerprint(cls, sql: str) -> str:
        # Simplistic regex to strip constants and parameters
        import re
        normalized = sql.lower().strip()
        # Replace numbers, values, parameters
        normalized = re.sub(r"'\d+'|\d+|\?", "?", normalized)
        return normalized

class IndexAdvisor:
    _filter_frequencies: Dict[str, int] = {}
    _suggested_indexes: set = set()

    @classmethod
    def track_filter(cls, table: str, column: str):
        key = f"{table}.{column}"
        cls._filter_frequencies[key] = cls._filter_frequencies.get(key, 0) + 1
        
        # If column filtered > 10 times and not already indexed, suggest
        if cls._filter_frequencies[key] >= 10 and key not in cls._suggested_indexes:
            cls._suggested_indexes.add(key)
            logger.info(
                f"[Index Advisor] Recommending INDEX on column '{column}' in table '{table}' due to high filter frequency."
            )
