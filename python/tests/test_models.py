import pytest
import asyncio
from bulldb import BaseModel, PrimaryKey, Unique, Index, MultiDatabase, UUID, Email, EncryptedString, HashedPassword

# Define models
class User(BaseModel):
    id: UUID = PrimaryKey()
    email: Email = Unique()
    secret_note: str = EncryptedString()
    password: str = HashedPassword()

@pytest.fixture
def db():
    # MultiDatabase defaults to sqlite memory pool if no other is defined
    instance = MultiDatabase()
    return instance

@pytest.mark.asyncio
async def test_user_active_record_flow(db):
    await db.connect_all()
    BaseModel.set_db(db)
    
    # 1. Initialize DB migrations
    from bulldb.migration import MigrationEngine
    migrator = MigrationEngine(db)
    migrator.register_model(User)
    await migrator.generate_and_apply_schema()

    # 2. Save User instance via create()
    user = await User.create(
        email="test@example.com",
        secret_note="Top Secret Info",
        password="mySecurePassword"
    )

    # Confirm key generation and encryption/hashing properties
    assert user.id is not None
    assert user.email == "test@example.com"
    
    # 3. Retrieve user via get_by_id and find_first
    fetched_user = await User.get_by_id(user.id)
    assert fetched_user.email == "test@example.com"

    first_user = await User.find_first(email="test@example.com")
    assert first_user is not None
    assert first_user.id == user.id

    # Test count
    user_count = await User.count()
    assert user_count == 1

    # Test reload
    user.email = "modified@example.com"
    await user.reload()
    assert user.email == "test@example.com"

    # Test to_dict decryptions
    user_dict = user.to_dict()
    assert user_dict["email"] == "test@example.com"
    assert user_dict["secret_note"] == "Top Secret Info"

    # Verify password verification flow
    from bulldb.security import SecurityEngine
    assert SecurityEngine.verify_password("mySecurePassword", fetched_user.password) is True

    # 4. Clean up
    await fetched_user.delete()
    assert (await User.count()) == 0
    await db.disconnect_all()

@pytest.mark.asyncio
async def test_reverse_engineering_generator(db):
    import os
    import tempfile
    from bulldb.generator import ModelGenerator
    from bulldb.migration import MigrationEngine
    await db.connect_all()
    
    # Setup users table via migrations first
    migrator = MigrationEngine(db)
    migrator.register_model(User)
    await migrator.generate_and_apply_schema()

    with tempfile.TemporaryDirectory() as tmpdir:
        output_file = os.path.join(tmpdir, "generated_models.py")
        await ModelGenerator.reverse_engineer(db, output_file)
        assert os.path.exists(output_file)
        with open(output_file, "r") as f:
            content = f.read()
        assert "class User(BaseModel):" in content or "class Users(BaseModel):" in content
        assert "id: UUID = PrimaryKey()" in content


@pytest.mark.asyncio
async def test_advanced_migrations_and_diffs(db):
    from bulldb.migration import MigrationEngine
    from bulldb import Index
    
    await db.connect_all()
    BaseModel.set_db(db)
    
    # Define dynamic classes inside test to simulate schema evolutions
    class SchemaV1(BaseModel):
        __table_name__ = "evolution_test"
        id: UUID = PrimaryKey()
        title: str
        old_val: str
        indexed_col: str = Index()
        
    mig = MigrationEngine(db)
    mig.register_model(SchemaV1)
    await mig.generate_and_apply_schema()
    
    # Let's save a record in V1
    await SchemaV1.create(id="11111111-2222-3333-4444-555555555555", title="Hello", old_val="RemoveMe", indexed_col="IndexMe")
    
    # Check index exists
    index_rows = await db.execute("PRAGMA index_list(evolution_test)")
    index_names = [r["name"] for r in index_rows]
    assert any("indexed_col" in n for n in index_names)
    
    # Class SchemaV2 (added "new_val", dropped "old_val", updated "title" type/attributes)
    class SchemaV2(BaseModel):
        __table_name__ = "evolution_test"
        id: UUID = PrimaryKey()
        title: int # Type changed to int (REAL/INTEGER in SQLite)
        new_val: str
        indexed_col: str # Index removed
        
    # Re-run migrator for V2
    mig2 = MigrationEngine(db)
    mig2.register_model(SchemaV2)
    await mig2.generate_and_apply_schema()
    
    # Verify that:
    # 1. new_val column is added
    # 2. old_val column is removed
    # 3. title type matches INTEGER (or real)
    # 4. the index on indexed_col is dropped
    pragma_rows = await db.execute("PRAGMA table_info(evolution_test)")
    cols = {r["name"]: r["type"] for r in pragma_rows}
    assert "new_val" in cols
    assert "old_val" not in cols
    assert "INTEGER" in cols["title"] or "REAL" in cols["title"]
    
    # Verify data copy
    rows = await db.execute("SELECT * FROM evolution_test")
    assert len(rows) == 1
    assert rows[0]["id"] == "11111111-2222-3333-4444-555555555555"
    assert rows[0]["indexed_col"] == "IndexMe"
    
    # Clean up
    await db.disconnect_all()

