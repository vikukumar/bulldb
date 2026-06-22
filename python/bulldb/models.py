from typing import Any, Dict, List, Optional, Type, get_type_hints
from .types import UniversalType, UUID

class FieldDecorator:
    def __init__(self, primary_key: bool = False, unique: bool = False, index: bool = False, default: Any = None):
        self.primary_key = primary_key
        self.unique = unique
        self.index = index
        self.default = default
        self.name: Optional[str] = None
        self.datatype: Optional[UniversalType] = None

    def __get__(self, instance, owner):
        if instance is None:
            return self
        return instance.__dict__.get(self.name, self.default)

    def __set__(self, instance, value):
        instance.__dict__[self.name] = value

class PrimaryKey(FieldDecorator):
    def __init__(self, **kwargs):
        super().__init__(primary_key=True, unique=True, index=True, **kwargs)

class Unique(FieldDecorator):
    def __init__(self, **kwargs):
        super().__init__(unique=True, index=True, **kwargs)

class Index(FieldDecorator):
    def __init__(self, **kwargs):
        super().__init__(index=True, **kwargs)

class Relationship:
    def __init__(self, type_name: str, target: str, back_populates: Optional[str] = None, **kwargs):
        self.type_name = type_name # 'OneToOne', 'OneToMany', 'ManyToOne', 'ManyToMany'
        self.target = target
        self.back_populates = back_populates
        self.options = kwargs
        self.name: Optional[str] = None

def OneToOne(target: str, back_populates: Optional[str] = None, **kwargs) -> Relationship:
    return Relationship("OneToOne", target, back_populates, **kwargs)

def OneToMany(target: str, back_populates: Optional[str] = None, **kwargs) -> Relationship:
    return Relationship("OneToMany", target, back_populates, **kwargs)

def ManyToOne(target: str, back_populates: Optional[str] = None, **kwargs) -> Relationship:
    return Relationship("ManyToOne", target, back_populates, **kwargs)

def ManyToMany(target: str, back_populates: Optional[str] = None, **kwargs) -> Relationship:
    return Relationship("ManyToMany", target, back_populates, **kwargs)


class ModelMetaclass(type):
    def __new__(mcs, name, bases, namespace, **kwargs):
        cls = super().__new__(mcs, name, bases, namespace)
        if name == "BaseModel":
            return cls

        fields: Dict[str, FieldDecorator] = {}
        relationships: Dict[str, Relationship] = {}

        # Scan for annotated types using get_type_hints or cls.__annotations__
        try:
            from typing import get_type_hints
            annotations = get_type_hints(cls)
        except Exception:
            annotations = getattr(cls, "__annotations__", {})

        # Process class dictionary values
        for key, value in list(namespace.items()):
            if isinstance(value, FieldDecorator):
                value.name = key
                ann = annotations.get(key)
                if isinstance(ann, UniversalType):
                    value.datatype = ann
                elif ann is not None:
                    if hasattr(ann, "__name__"):
                        value.datatype = UniversalType(ann.__name__)
                    else:
                        value.datatype = UniversalType(str(ann))
                else:
                    value.datatype = UniversalType("str")
                fields[key] = value
            elif isinstance(value, UniversalType):
                fd = FieldDecorator()
                fd.name = key
                fd.datatype = value
                setattr(cls, key, fd)
                fields[key] = fd
            elif isinstance(value, Relationship):
                value.name = key
                relationships[key] = value

        # Check annotations for fields declared without decorators
        for key, ann in annotations.items():
            if key not in fields and key not in relationships and not key.startswith("_"):
                fd = FieldDecorator()
                fd.name = key
                if isinstance(ann, UniversalType):
                    fd.datatype = ann
                elif hasattr(ann, "__name__"):
                    fd.datatype = UniversalType(ann.__name__)
                else:
                    fd.datatype = UniversalType(str(ann))
                fields[key] = fd
                setattr(cls, key, fd)

        cls._fields = fields
        cls._relationships = relationships
        cls._table_name = getattr(cls, "__table_name__", name.lower() + "s")

        return cls


class BaseModel(metaclass=ModelMetaclass):
    _fields: Dict[str, FieldDecorator] = {}
    _relationships: Dict[str, Relationship] = {}
    _table_name: str = ""
    _db: Any = None # assigned from multi-database registry

    def __init__(self, **kwargs):
        for key, field in self._fields.items():
            val = kwargs.get(key, field.default)
            # call security hooks or assign
            setattr(self, key, val)
        for key, rel in self._relationships.items():
            if key in kwargs:
                setattr(self, key, kwargs[key])

    @classmethod
    def set_db(cls, db: Any):
        cls._db = db

    async def save(self) -> "BaseModel":
        if not self._db:
            raise ValueError(f"No database client registered for model {self.__class__.__name__}. Connect via MultiDatabase first.")
        # Trigger encryption before save (handled in security module)
        from .security import SecurityEngine
        from .ai import AIEngine

        # Auto-compute embeddings if configured
        for field_name, field in self._fields.items():
            if field.datatype and field.datatype.name == "Embedding":
                src_field = field.datatype.options.get("source_field")
                if src_field and getattr(self, src_field, None):
                    text_content = getattr(self, src_field)
                    vector_data = await AIEngine.generate_embeddings(text_content, provider=field.datatype.options.get("provider", "openai"))
                    setattr(self, field_name, vector_data)

        # Encrypt encrypted fields
        payload = {}
        for k, f in self._fields.items():
            val = getattr(self, k, None)
            if val is not None:
                if f.datatype and f.datatype.name in ("EncryptedString", "Secret"):
                    val = SecurityEngine.encrypt_field(val)
                    setattr(self, k, val)
                elif f.datatype and f.datatype.name == "HashedPassword":
                    val = SecurityEngine.hash_password(val)
                    setattr(self, k, val)
                payload[k] = val

        # Router write call
        pk_field = next((k for k, v in self._fields.items() if v.primary_key), "id")
        pk_val = getattr(self, pk_field, None)

        if pk_val:
            # Check if updating or inserting
            # For simplicity, do an upsert or check persistence
            await self._db.write(self._table_name, payload, upsert=True)
        else:
            # Generate primary key if missing and UUID/ULID
            if pk_field in self._fields:
                datatype_name = self._fields[pk_field].datatype.name
                if datatype_name == "UUID":
                    import uuid
                    pk_val = str(uuid.uuid4())
                elif datatype_name == "ULID":
                    # Generate simple unique id fallback
                    import time, random
                    pk_val = f"{int(time.time()*1000):012x}{random.getrandbits(80):020x}"
                setattr(self, pk_field, pk_val)
                payload[pk_field] = pk_val
            await self._db.write(self._table_name, payload, upsert=False)

        return self

    async def delete(self) -> bool:
        if not self._db:
            raise ValueError("No database client registered.")
        pk_field = next((k for k, v in self._fields.items() if v.primary_key), "id")
        pk_val = getattr(self, pk_field, None)
        if not pk_val:
            return False
        await self._db.delete(self._table_name, {pk_field: pk_val})
        return True

    @classmethod
    def find(cls) -> "QueryBuilder":
        from .query import QueryBuilder
        return QueryBuilder(cls)

    @classmethod
    async def create(cls, **kwargs) -> "BaseModel":
        instance = cls(**kwargs)
        await instance.save()
        return instance

    @classmethod
    async def get_by_id(cls, pk_val: Any) -> "BaseModel":
        pk_field = next((k for k, v in cls._fields.items() if v.primary_key), "id")
        results = await cls.find().where(pk_field, "=", pk_val).execute()
        if not results:
            raise KeyError(f"Record with {pk_field}={pk_val} not found in {cls._table_name}.")
        return results[0]

    @classmethod
    async def find_first(cls, **kwargs) -> Optional["BaseModel"]:
        builder = cls.find()
        for k, v in kwargs.items():
            builder = builder.where(k, "=", v)
        results = await builder.limit(1).execute()
        return results[0] if results else None

    @classmethod
    async def update_many(cls, filters: Dict[str, Any], payload: Dict[str, Any]) -> int:
        if not cls._db:
            raise ValueError("No database client registered.")
        driver = cls._db.get_route(cls._table_name, is_write=True)
        await driver.update(cls._table_name, payload, filters)
        return 1

    @classmethod
    async def delete_many(cls, filters: Dict[str, Any]) -> int:
        if not cls._db:
            raise ValueError("No database client registered.")
        driver = cls._db.get_route(cls._table_name, is_write=True)
        await driver.delete(cls._table_name, filters)
        return 1

    @classmethod
    async def count(cls, filters: Optional[Dict[str, Any]] = None) -> int:
        if not cls._db:
            raise ValueError("No database client registered.")
        builder = cls.find()
        if filters:
            for k, v in filters.items():
                builder = builder.where(k, "=", v)
        results = await builder.execute()
        return len(results)

    async def reload(self) -> "BaseModel":
        pk_field = next((k for k, v in self._fields.items() if v.primary_key), "id")
        pk_val = getattr(self, pk_field, None)
        if not pk_val:
            raise ValueError("Cannot reload an unpersisted instance without a primary key value.")
        db_instance = await self.get_by_id(pk_val)
        for key in self._fields.keys():
            setattr(self, key, getattr(db_instance, key))
        return self

    def to_dict(self) -> Dict[str, Any]:
        data = {}
        for key in self._fields.keys():
            val = getattr(self, key, None)
            from .security import SecurityEngine
            field_meta = self._fields[key]
            if val is not None and field_meta.datatype and field_meta.datatype.name in ("EncryptedString", "Secret"):
                val = SecurityEngine.decrypt_field(val)
            data[key] = val
        return data
