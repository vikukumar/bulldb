import pytest
import asyncio
from bulldb.database import MultiDatabase, CircuitBreaker, CircuitBreakerOpenException

@pytest.mark.asyncio
async def test_database_retry_and_circuit_breaker():
    # 1. Test Circuit Breaker thresholds
    cb = CircuitBreaker(failure_threshold=2, recovery_timeout=0.1)
    assert cb.allow_request() is True
    
    cb.record_failure()
    assert cb.allow_request() is True
    
    cb.record_failure()
    assert cb.allow_request() is False # Trip Open!

    # Wait for recovery timeout
    await asyncio.sleep(0.12)
    assert cb.allow_request() is True # Half-open state allowed

    # 2. Test MultiDatabase dynamic routing
    db = MultiDatabase()
    # Register secondary pool
    db.register_database("postgres_replica", "postgresql://localhost:5432/replica_db", is_replica=True)
    
    # Check Read/Write splitting
    write_driver = db.get_route("users", is_write=True)
    read_driver = db.get_route("users", is_write=False)
    
    assert write_driver.name == "sqlite" # Primary driver defaults to sqlite memory
    assert read_driver.name == "postgres_replica"


@pytest.mark.asyncio
async def test_sqlite_auto_creation_and_concurrency(tmp_path):
    # Test directory and file auto-creation
    import os
    db_file = tmp_path / "nested_dir" / "subdir" / "test.db"
    db_url = f"sqlite:///{db_file}"
    
    db = MultiDatabase()
    db.register_database("sqlite_file", db_url)
    db.primary_name = "sqlite_file"
    driver = db.drivers["sqlite_file"]
    
    await driver.connect()
    assert os.path.exists(db_file)
    assert os.path.exists(os.path.dirname(db_file))
    
    # Test concurrency safety
    await driver.execute("CREATE TABLE IF NOT EXISTS concurrency_test (id TEXT PRIMARY KEY, val TEXT)")
    
    async def insert_worker(i):
        # We do multiple writes and reads concurrently
        await db.write("concurrency_test", {"id": f"id_{i}", "val": f"val_{i}"}, upsert=True)
    
    # Run 50 concurrent inserts
    tasks = [insert_worker(i) for i in range(50)]
    await asyncio.gather(*tasks)
    
    rows = await driver.execute("SELECT COUNT(*) as count FROM concurrency_test")
    assert rows[0]["count"] == 50
    await driver.disconnect()


@pytest.mark.asyncio
async def test_oop_drivers_and_connection_info():
    from bulldb.database import MultiDatabase, PostgresDriver, MySQLDriver, MongoDriver, SQLiteDriver

    db = MultiDatabase()
    db.register_database("my_pg", "postgresql://dbuser:secretpass@dbhost:5432/mydb")
    db.register_database("my_mysql", "mysql://root:password123@127.0.0.1:3306/testdb")
    db.register_database("my_mongo", "mongodb://admin:pass@localhost:27017/admindb")
    db.register_database("my_sqlite", "sqlite:///data/store.db")

    assert isinstance(db.drivers["my_pg"], PostgresDriver)
    assert isinstance(db.drivers["my_mysql"], MySQLDriver)
    assert isinstance(db.drivers["my_mongo"], MongoDriver)
    assert isinstance(db.drivers["my_sqlite"], SQLiteDriver)

    # Postgres Info
    pg_info = db.drivers["my_pg"].get_connection_info()
    assert pg_info["driver"] == "postgres"
    assert pg_info["host"] == "dbhost"
    assert pg_info["port"] == 5432
    assert pg_info["database"] == "mydb"
    assert pg_info["username"] == "dbuser"

    # MySQL Info
    mysql_info = db.drivers["my_mysql"].get_connection_info()
    assert mysql_info["driver"] == "mysql"
    assert mysql_info["host"] == "127.0.0.1"
    assert mysql_info["port"] == 3306
    assert mysql_info["database"] == "testdb"
    assert mysql_info["username"] == "root"

    # Test connection
    test_res = await db.drivers["my_pg"].test_connection()
    assert test_res["success"] is True
    assert test_res["info"]["status"] == "CONNECTED"


