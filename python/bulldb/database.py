import os
import urllib.parse
import asyncio
import logging
from typing import Dict, Any, List, Optional, Callable

logger = logging.getLogger("bulldb.database")

class CircuitBreakerOpenException(Exception):
    pass

class CircuitBreaker:
    def __init__(self, failure_threshold: int = 5, recovery_timeout: float = 10.0):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.failure_count = 0
        self.state = "CLOSED" # CLOSED, OPEN, HALF-OPEN
        self.last_state_change = 0.0

    def record_success(self):
        self.failure_count = 0
        self.state = "CLOSED"

    def record_failure(self):
        self.failure_count += 1
        import time
        if self.failure_count >= self.failure_threshold:
            self.state = "OPEN"
            self.last_state_change = time.time()
            logger.warning(f"Circuit breaker tripped! State set to OPEN. Threshold: {self.failure_threshold}")

    def allow_request(self) -> bool:
        import time
        if self.state == "CLOSED":
            return True
        if self.state == "OPEN":
            if time.time() - self.last_state_change > self.recovery_timeout:
                self.state = "HALF-OPEN"
                logger.info("Circuit breaker entering HALF-OPEN state, checking system viability.")
                return True
            return False
        if self.state == "HALF-OPEN":
            return True
        return False

class DatabaseDriver:
    def __init__(self, name: str, url: str):
        self.name = name
        self.url = url
        self.parsed_url = urllib.parse.urlparse(url)
        self.circuit_breaker = CircuitBreaker()

    async def connect(self):
        pass

    async def disconnect(self):
        pass

    async def ping(self) -> bool:
        return True

    async def ensure_connected(self):
        try:
            if not await self.ping():
                await self.connect()
        except Exception:
            await self.connect()

    async def execute(self, query: str, params: Optional[tuple] = None) -> List[Dict[str, Any]]:
        return []

    async def insert(self, table: str, payload: Dict[str, Any]) -> Any:
        return {}

    async def update(self, table: str, payload: Dict[str, Any], filters: Dict[str, Any]) -> Any:
        return {}

    async def delete(self, table: str, filters: Dict[str, Any]) -> Any:
        return {}

    async def execute_mongo_find(self, collection: str, filters: Dict[str, Any], projection: Dict[str, Any], limit: Optional[int]) -> List[Dict[str, Any]]:
        if hasattr(self, "db") and not isinstance(self.db, dict):
            cursor = self.db[collection].find(filters, projection)
            if limit:
                cursor = cursor.limit(limit)
            return list(cursor)
        return []

    async def execute_search(self, index: str, body: Dict[str, Any], limit: int) -> List[Dict[str, Any]]:
        return []

    async def execute_vector_search(self, collection: str, vector: Optional[List[float]], filters: Dict[str, Any], limit: int) -> List[Dict[str, Any]]:
        return []

class SQLiteDriver(DatabaseDriver):
    def __init__(self, name: str, url: str):
        super().__init__(name, url)
        self._lock = None

    @property
    def lock(self) -> asyncio.Lock:
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    async def connect(self):
        async with self.lock:
            await self._connect()

    async def _connect(self):
        import sqlite3
        db_path = self.parsed_url.path
        if self.url.startswith("sqlite://"):
            db_path = self.url[9:]
            if db_path.startswith("/:memory:"):
                db_path = db_path[1:]
            if db_path.startswith("/"):
                import platform
                if len(db_path) > 2 and db_path[2] == ":" and db_path[1].isalpha():
                    db_path = db_path[1:]
                elif platform.system() == "Windows":
                    db_path = db_path[1:]
            if "?" in db_path:
                db_path = db_path.split("?")[0]
        
        db_path = db_path or ":memory:"

        if db_path != ":memory:":
            db_dir = os.path.dirname(os.path.abspath(db_path))
            if db_dir and not os.path.exists(db_dir):
                os.makedirs(db_dir, exist_ok=True)
            with open(db_path, "a"):
                pass

        if hasattr(self, "conn") and self.conn:
            try:
                self.conn.close()
            except Exception:
                pass
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.cursor = self.conn.cursor()

    async def disconnect(self):
        async with self.lock:
            await self._disconnect()

    async def _disconnect(self):
        if hasattr(self, "conn") and self.conn:
            try:
                self.conn.close()
            except Exception:
                pass

    async def ping(self) -> bool:
        async with self.lock:
            return await self._ping()

    async def _ping(self) -> bool:
        try:
            if not hasattr(self, "cursor") or self.cursor is None:
                return False
            self.cursor.execute("SELECT 1")
            return True
        except Exception:
            return False

    async def ensure_connected(self):
        async with self.lock:
            await self._ensure_connected()

    async def _ensure_connected(self):
        try:
            if not await self._ping():
                await self._connect()
        except Exception:
            await self._connect()

    async def execute(self, query: str, params: Optional[tuple] = None) -> List[Dict[str, Any]]:
        if not self.circuit_breaker.allow_request():
            raise CircuitBreakerOpenException(f"Database driver {self.name} circuit is OPEN")
        async with self.lock:
            await self._ensure_connected()
            try:
                self.cursor.execute(query, params or ())
                is_write = any(query.strip().upper().startswith(kw) for kw in ["INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "REPLACE"])
                if is_write:
                    self.conn.commit()
                rows = self.cursor.fetchall()
                self.circuit_breaker.record_success()
                return [dict(row) for row in rows]
            except Exception as e:
                self.circuit_breaker.record_failure()
                raise e

    async def insert(self, table: str, payload: Dict[str, Any]) -> Any:
        keys = list(payload.keys())
        values = list(payload.values())
        placeholders = ", ".join(["?" for _ in keys])
        query = f"INSERT INTO {table} ({', '.join(keys)}) VALUES ({placeholders})"
        await self.execute(query, tuple(values))
        return payload

    async def update(self, table: str, payload: Dict[str, Any], filters: Dict[str, Any]) -> Any:
        set_clause = ", ".join([f"{k} = ?" for k in payload.keys()])
        where_clause = " AND ".join([f"{k} = ?" for k in filters.keys()])
        query = f"UPDATE {table} SET {set_clause} WHERE {where_clause}"
        params = tuple(list(payload.values()) + list(filters.values()))
        await self.execute(query, params)
        return payload

    async def delete(self, table: str, filters: Dict[str, Any]) -> Any:
        where_clause = " AND ".join([f"{k} = ?" for k in filters.keys()])
        query = f"DELETE FROM {table} WHERE {where_clause}"
        await self.execute(query, tuple(filters.values()))
        return True

class MongoDriver(DatabaseDriver):
    async def connect(self):
        # Dynamically import pymongo
        try:
            from pymongo import MongoClient
            if hasattr(self, "client") and self.client:
                try:
                    self.client.close()
                except Exception:
                    pass
            self.client = MongoClient(self.url)
            db_name = self.parsed_url.path.strip("/") or "bulldb"
            self.db = self.client[db_name]
        except ImportError:
            # Fallback mock for testing in case pymongo isn't installed
            self.db = {}

    async def disconnect(self):
        if hasattr(self, "client") and self.client:
            try:
                self.client.close()
            except Exception:
                pass

    async def ping(self) -> bool:
        if isinstance(self.db, dict): return True
        try:
            self.client.admin.command('ping')
            return True
        except Exception:
            return False

    async def insert(self, table: str, payload: Dict[str, Any]) -> Any:
        if isinstance(self.db, dict): return payload
        self.db[table].insert_one(payload)
        return payload

    async def update(self, table: str, payload: Dict[str, Any], filters: Dict[str, Any]) -> Any:
        if isinstance(self.db, dict): return payload
        self.db[table].update_many(filters, {"$set": payload})
        return payload

    async def delete(self, table: str, filters: Dict[str, Any]) -> Any:
        if isinstance(self.db, dict): return True
        self.db[table].delete_many(filters)
        return True

class MultiDatabase:
    def __init__(self):
        self.drivers: Dict[str, DatabaseDriver] = {}
        self.primary_name: Optional[str] = None
        self.replicas: List[str] = []
        self.shards: Dict[str, List[str]] = {}
        self.discover_environment()

    def discover_environment(self):
        # Auto DB detection from standard environment variables
        env_mappings = {
            "SQLITE_URL": "sqlite",
            "POSTGRES_URL": "postgres",
            "DATABASE_URL": "postgres",
            "MYSQL_URL": "mysql",
            "MONGO_URL": "mongo"
        }
        for env_var, engine in env_mappings.items():
            url = os.getenv(env_var)
            if url:
                self.register_database(engine, url)
                if not self.primary_name:
                    self.primary_name = engine

        # Default SQLite memory driver if no variables exist
        if not self.drivers:
            self.register_database("sqlite", "sqlite:///:memory:")
            self.primary_name = "sqlite"

    def register_database(self, name: str, url: str, is_replica: bool = False, shard_key: Optional[str] = None):
        if url.startswith("sqlite"):
            driver = SQLiteDriver(name, url)
        elif url.startswith("mongodb"):
            driver = MongoDriver(name, url)
        else:
            driver = DatabaseDriver(name, url) # Generic wrapper

        self.drivers[name] = driver
        if is_replica:
            self.replicas.append(name)
        
        if shard_key:
            if shard_key not in self.shards:
                self.shards[shard_key] = []
            self.shards[shard_key].append(name)

    async def connect_all(self):
        for driver in self.drivers.values():
            await driver.connect()

    async def disconnect_all(self):
        for driver in self.drivers.values():
            await driver.disconnect()

    def get_route(self, table: str, is_write: bool = False, shard_id: Optional[str] = None) -> DatabaseDriver:
        # 1. Sharding routing
        if shard_id and shard_id in self.shards:
            target_names = self.shards[shard_id]
            import random
            return self.drivers[random.choice(target_names)]

        # 2. Read/Write splitting
        if not is_write and self.replicas:
            import random
            return self.drivers[random.choice(self.replicas)]

        # 3. Default to primary
        return self.drivers[self.primary_name]

    async def execute(self, query: str, params: Optional[tuple] = None, is_write: bool = False) -> List[Dict[str, Any]]:
        driver = self.get_route("", is_write=is_write)
        return await self.retry_with_backoff(driver, driver.execute, query, params)

    async def write(self, table: str, payload: Dict[str, Any], upsert: bool = False) -> Any:
        driver = self.get_route(table, is_write=True)
        await driver.ensure_connected()
        if isinstance(driver, SQLiteDriver):
            async with driver.lock:
                await driver._ensure_connected()
                driver.cursor.execute("BEGIN TRANSACTION")
                try:
                    if upsert:
                        pk_field = "id"
                        pk_val = payload.get(pk_field)
                        if pk_val:
                            check_query = f"SELECT {pk_field} FROM {table} WHERE {pk_field} = ?"
                            driver.cursor.execute(check_query, (pk_val,))
                            exists = driver.cursor.fetchone()
                            if exists:
                                set_clause = ", ".join([f"{k} = ?" for k in payload.keys() if k != pk_field])
                                where_clause = f"{pk_field} = ?"
                                params = tuple([v for k, v in payload.items() if k != pk_field] + [pk_val])
                                driver.cursor.execute(f"UPDATE {table} SET {set_clause} WHERE {where_clause}", params)
                                driver.conn.commit()
                                return payload
                    keys = list(payload.keys())
                    values = list(payload.values())
                    placeholders = ", ".join(["?" for _ in keys])
                    query = f"INSERT INTO {table} ({', '.join(keys)}) VALUES ({placeholders})"
                    driver.cursor.execute(query, tuple(values))
                    driver.conn.commit()
                    return payload
                except Exception as e:
                    driver.conn.rollback()
                    raise e
        else:
            if upsert:
                pk_field = "id"
                pk_val = payload.get(pk_field)
                if pk_val:
                    check_query = f"SELECT {pk_field} FROM {table} WHERE {pk_field} = ?"
                    exists = await driver.execute(check_query, (pk_val,))
                    if exists:
                        filters = {pk_field: pk_val}
                        payload_no_pk = {k: v for k, v in payload.items() if k != pk_field}
                        return await driver.update(table, payload_no_pk, filters)
            return await driver.insert(table, payload)

    async def delete(self, table: str, filters: Dict[str, Any]) -> Any:
        driver = self.get_route(table, is_write=True)
        await driver.ensure_connected()
        return await driver.delete(table, filters)

    async def retry_with_backoff(self, driver: DatabaseDriver, func: Callable, *args, retries: int = 3, initial_delay: float = 0.5, **kwargs):
        delay = initial_delay
        last_exception = None
        for i in range(retries):
            try:
                await driver.ensure_connected()
                return await func(*args, **kwargs)
            except Exception as e:
                last_exception = e
                logger.warning(f"Database operation failed. Retry {i+1}/{retries} in {delay}s. Error: {str(e)}")
                await asyncio.sleep(delay)
                delay *= 2
        raise last_exception or Exception("Database execution retries exhausted.")
