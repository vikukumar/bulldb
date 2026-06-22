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
