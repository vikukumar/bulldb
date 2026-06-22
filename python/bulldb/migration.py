import time
import logging
from typing import Dict, List, Any, Set, Tuple
from .models import BaseModel
from .types import DataTypeMapper

logger = logging.getLogger("bulldb.migration")

class MigrationNode:
    def __init__(self, name: str, dependencies: Set[str]):
        self.name = name
        self.dependencies = dependencies

class MigrationEngine:
    def __init__(self, db: Any):
        self.db = db
        self.registered_models: List[type] = []

    def register_model(self, model: type):
        if issubclass(model, BaseModel) and model not in self.registered_models:
            self.registered_models.append(model)

    def discover_models(self):
        # Auto-discover all subclasses of BaseModel
        def get_subclasses(cls):
            subclasses = set(cls.__subclasses__())
            for subclass in cls.__subclasses__():
                subclasses.update(get_subclasses(subclass))
            return subclasses
        
        for sub in get_subclasses(BaseModel):
            # Skip base classes if any, only register concrete model classes
            if sub.__name__ not in ("BaseModel", "AuthUser", "AuthAccount", "AuthSession", "VerificationToken") or hasattr(sub, "_fields"):
                self.register_model(sub)

    def sort_models_topologically(self) -> List[type]:
        # Sorts models by relationship dependencies to prevent foreign key errors on creation
        resolved = []
        visited = set()
        
        # Build dependency graph
        dependencies: Dict[str, Set[str]] = {}
        model_by_name = {}
        for m in self.registered_models:
            name = m.__name__
            model_by_name[name] = m
            dependencies[name] = set()
            for r in m._relationships.values():
                if r.type_name in ("ManyToOne", "OneToOne"):
                    dependencies[name].add(r.target)

        def visit(name: str):
            if name in visited:
                return
            if name not in model_by_name:
                return # reference to outside class or unresolved target
            
            # visit dependencies first
            for dep in dependencies.get(name, []):
                visit(dep)
            
            visited.add(name)
            resolved.append(model_by_name[name])

        for m in self.registered_models:
            visit(m.__name__)

        return resolved

    def _normalize_type(self, t: str) -> str:
        t = t.upper()
        if any(x in t for x in ("INT", "SERIAL")):
            return "INTEGER"
        if any(x in t for x in ("CHAR", "TEXT", "UUID", "EMAIL", "PHONE", "URL", "IPADDRESS")):
            return "TEXT"
        if any(x in t for x in ("REAL", "FLOAT", "DOUBLE", "NUMERIC", "DECIMAL")):
            return "REAL"
        if any(x in t for x in ("BLOB", "BYTEA", "BINARY")):
            return "BLOB"
        return "TEXT"

    async def _recreate_table_sqlite(self, table_name: str, model: type):
        # Disable foreign keys temporarily
        await self.db.execute("PRAGMA foreign_keys = OFF")
        try:
            # Fetch current columns to find the common ones
            pragma_rows = await self.db.execute(f"PRAGMA table_info({table_name})")
            db_cols = {r["name"] for r in pragma_rows}
            model_cols = {col_name for col_name in model._fields.keys()}
            common_cols = list(db_cols.intersection(model_cols))

            # Rename current table
            temp_name = f"{table_name}_old_{int(time.time())}"
            await self.db.execute(f"ALTER TABLE {table_name} RENAME TO {temp_name}")

            # Recreate table with new schema
            columns_sql = []
            for col_name, col_meta in model._fields.items():
                col_type = DataTypeMapper.map_to_sqlite(col_meta.datatype)
                constraints = []
                if col_meta.primary_key:
                    constraints.append("PRIMARY KEY")
                if col_meta.unique and not col_meta.primary_key:
                    constraints.append("UNIQUE")
                columns_sql.append(f"{col_name} {col_type} {' '.join(constraints)}")

            # Generate Foreign Key constraints
            for rel_name, rel in model._relationships.items():
                if rel.type_name in ("ManyToOne", "OneToOne"):
                    target_model = next((m for m in self.registered_models if m.__name__ == rel.target), None)
                    if target_model:
                        target_table = target_model._table_name
                        target_pk = next((k for k, v in target_model._fields.items() if v.primary_key), "id")
                        fk_col = rel.options.get("foreign_key", f"{rel_name}_id")
                        if fk_col in model._fields:
                            columns_sql.append(f"FOREIGN KEY ({fk_col}) REFERENCES {target_table} ({target_pk}) ON DELETE CASCADE")

            create_sql = f"CREATE TABLE {table_name} ({', '.join(columns_sql)})"
            await self.db.execute(create_sql)

            # Copy data for common columns
            if common_cols:
                cols_str = ", ".join(common_cols)
                await self.db.execute(f"INSERT INTO {table_name} ({cols_str}) SELECT {cols_str} FROM {temp_name}")

            # Drop temporary old table
            await self.db.execute(f"DROP TABLE {temp_name}")
        finally:
            await self.db.execute("PRAGMA foreign_keys = ON")

    async def generate_and_apply_schema(self):
        # 0. Discover models if none registered
        if not self.registered_models:
            self.discover_models()

        # 1. Initialize migration log table
        await self._init_migration_table()

        driver_name = self.db.primary_name or "sqlite"

        # 2. Fetch all tables from DB
        db_tables = []
        try:
            if "sqlite" in driver_name:
                rows = await self.db.execute("SELECT name FROM sqlite_master WHERE type='table'")
                db_tables = [r["name"] for r in rows]
            else:
                rows = await self.db.execute("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")
                db_tables = [r["table_name"] for r in rows]
        except Exception:
            pass

        # 3. Drop tables no longer present in models (excluding system tables and logs)
        model_tables = {m._table_name for m in self.registered_models}
        for table in db_tables:
            if table not in model_tables and table != "bulldb_migrations" and not table.startswith("sqlite_") and not table.startswith("pg_"):
                logger.info(f"Dropping unused database table: {table}")
                try:
                    await self.db.execute(f"DROP TABLE IF EXISTS {table}")
                except Exception as e:
                    logger.warning(f"Failed to drop table {table}: {e}")

        # 4. Sort and migrate models
        sorted_models = self.sort_models_topologically()

        for model in sorted_models:
            table_name = model._table_name
            existing_columns: Dict[str, Dict[str, Any]] = {}
            table_exists = table_name in db_tables

            # Fetch columns schema detail if table exists
            if table_exists:
                try:
                    if "sqlite" in driver_name:
                        pragma_rows = await self.db.execute(f"PRAGMA table_info({table_name})")
                        for r in pragma_rows:
                            existing_columns[r["name"]] = {
                                "type": r["type"].upper(),
                                "pk": r["pk"] == 1,
                                "unique": False # SQLite doesn't show unique in table_info directly
                            }
                        # Query unique columns via indexes
                        index_rows = await self.db.execute(f"PRAGMA index_list({table_name})")
                        for idx in index_rows:
                            if idx["unique"] == 1:
                                idx_info = await self.db.execute(f"PRAGMA index_info({idx['name']})")
                                for c in idx_info:
                                    if c["name"] in existing_columns:
                                        existing_columns[c["name"]]["unique"] = True
                    else:
                        # Postgres columns
                        col_rows = await self.db.execute(
                            f"SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name = '{table_name}'"
                        )
                        for r in col_rows:
                            existing_columns[r["column_name"]] = {
                                "type": r["data_type"].upper(),
                                "pk": False,
                                "unique": False
                            }
                        # Parse primary key constraint
                        pk_rows = await self.db.execute(
                            f"""SELECT kcu.column_name 
                               FROM information_schema.table_constraints tc 
                               JOIN information_schema.key_column_usage kcu 
                                 ON tc.constraint_name = kcu.constraint_name 
                                 AND tc.table_schema = kcu.table_schema 
                               WHERE tc.constraint_type = 'PRIMARY KEY' 
                                 AND tc.table_name = '{table_name}'"""
                        )
                        for r in pk_rows:
                            if r["column_name"] in existing_columns:
                                existing_columns[r["column_name"]]["pk"] = True
                except Exception as e:
                    logger.warning(f"Error reading metadata for table {table_name}: {e}")

            if not table_exists:
                # 1. CREATE TABLE
                columns_sql = []
                for col_name, col_meta in model._fields.items():
                    col_type = DataTypeMapper.map_to_sqlite(col_meta.datatype) if "sqlite" in driver_name else DataTypeMapper.map_to_postgresql(col_meta.datatype)
                    constraints = []
                    if col_meta.primary_key:
                        constraints.append("PRIMARY KEY")
                    if col_meta.unique and not col_meta.primary_key:
                        constraints.append("UNIQUE")
                    columns_sql.append(f"{col_name} {col_type} {' '.join(constraints)}")

                sql = f"CREATE TABLE IF NOT EXISTS {table_name} ({', '.join(columns_sql)})"
                await self.db.execute(sql)

                # Record migration
                insert_mig = "INSERT INTO bulldb_migrations (migration_name, applied_at) VALUES (?, ?)"
                await self.db.execute(insert_mig, (f"create_{table_name}", int(time.time())))
            else:
                # 2. DIFF AND ALTER TABLE
                needs_sqlite_recreation = False
                postgres_ddl_ops = []

                # Columns additions / updates checks
                for col_name, col_meta in model._fields.items():
                    col_type = DataTypeMapper.map_to_sqlite(col_meta.datatype) if "sqlite" in driver_name else DataTypeMapper.map_to_postgresql(col_meta.datatype)
                    
                    if col_name not in existing_columns:
                        # New column!
                        if "sqlite" in driver_name:
                            # SQLite ADD COLUMN constraint restrictions (cannot add primary/unique columns directly)
                            if col_meta.primary_key or col_meta.unique:
                                needs_sqlite_recreation = True
                            else:
                                alter_sql = f"ALTER TABLE {table_name} ADD COLUMN {col_name} {col_type}"
                                await self.db.execute(alter_sql)
                        else:
                            postgres_ddl_ops.append(f"ADD COLUMN {col_name} {col_type}")
                            if col_meta.unique:
                                postgres_ddl_ops.append(f"ADD CONSTRAINT {table_name}_{col_name}_key UNIQUE ({col_name})")
                    else:
                        # Compare Type, Primary Key, and Unique
                        db_col = existing_columns[col_name]
                        normalized_db = self._normalize_type(db_col["type"])
                        normalized_model = self._normalize_type(col_type)

                        type_mismatch = normalized_db != normalized_model
                        pk_mismatch = col_meta.primary_key != db_col["pk"]
                        unique_mismatch = col_meta.unique != db_col["unique"]

                        if type_mismatch or pk_mismatch or unique_mismatch:
                            if "sqlite" in driver_name:
                                needs_sqlite_recreation = True
                            else:
                                if type_mismatch:
                                    postgres_ddl_ops.append(f"ALTER COLUMN {col_name} TYPE {col_type} USING {col_name}::{col_type}")
                                if unique_mismatch:
                                    if col_meta.unique:
                                        postgres_ddl_ops.append(f"ADD CONSTRAINT {table_name}_{col_name}_key UNIQUE ({col_name})")
                                    else:
                                        postgres_ddl_ops.append(f"DROP CONSTRAINT IF EXISTS {table_name}_{col_name}_key")

                # Columns deletion checks
                for col_name in list(existing_columns.keys()):
                    if col_name not in model._fields and col_name not in ("id", "applied_at"):
                        if "sqlite" in driver_name:
                            needs_sqlite_recreation = True
                        else:
                            postgres_ddl_ops.append(f"DROP COLUMN {col_name}")

                # Execute SQLite Table Reconstruction or PostgreSQL DDL
                if "sqlite" in driver_name and needs_sqlite_recreation:
                    await self._recreate_table_sqlite(table_name, model)
                elif postgres_ddl_ops:
                    ddl_ops_str = ", ".join(postgres_ddl_ops)
                    alter_sql = f"ALTER TABLE {table_name} {ddl_ops_str}"
                    await self.db.execute(alter_sql)

            # 3. INDEXES LIFECYCLE
            # Fetch existing indexes
            db_indexes = []
            try:
                if "sqlite" in driver_name:
                    rows = await self.db.execute(f"PRAGMA index_list({table_name})")
                    db_indexes = [r["name"] for r in rows]
                else:
                    rows = await self.db.execute(f"SELECT indexname FROM pg_indexes WHERE tablename = '{table_name}'")
                    db_indexes = [r["indexname"] for r in rows]
            except Exception:
                pass

            # Create new indexes
            for col_name, col_meta in model._fields.items():
                idx_name = f"{table_name}_{col_name}_idx"
                if col_meta.index and not col_meta.primary_key:
                    if idx_name not in db_indexes:
                        await self.db.execute(f"CREATE INDEX IF NOT EXISTS {idx_name} ON {table_name} ({col_name})")

            # Drop removed indexes
            for idx in db_indexes:
                # Target our auto-generated indexes like {table}_{col}_idx
                if idx.startswith(f"{table_name}_") and idx.endswith("_idx"):
                    col_name = idx[len(table_name)+1:-4]
                    if col_name not in model._fields or not model._fields[col_name].index:
                        await self.db.execute(f"DROP INDEX IF EXISTS {idx}")

    async def _init_migration_table(self):
        driver_name = self.db.primary_name or "sqlite"
        col_type = "TEXT" if "sqlite" in driver_name else "VARCHAR(255)"
        sql = f"""
        CREATE TABLE IF NOT EXISTS bulldb_migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            migration_name {col_type} UNIQUE,
            applied_at INTEGER
        )
        """
        if "postgres" in driver_name:
            sql = """
            CREATE TABLE IF NOT EXISTS bulldb_migrations (
                id SERIAL PRIMARY KEY,
                migration_name VARCHAR(255) UNIQUE,
                applied_at INTEGER
            )
            """
        await self.db.execute(sql)
