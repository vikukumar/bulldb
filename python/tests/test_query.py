import pytest
from bulldb import BaseModel, PrimaryKey, Unique
from bulldb.query import QueryBuilder, QueryCompiler

class Product(BaseModel):
    id: int = PrimaryKey()
    name: str = Unique()
    category: str

def test_query_sql_compiler():
    builder = Product.find().where("category", "=", "Electronics").order_by("name", "DESC").limit(10)
    sql, params = QueryCompiler.compile_to_sql(builder.ast)
    
    assert "SELECT" in sql
    assert "FROM products" in sql
    assert "category = ?" in sql
    assert "ORDER BY name DESC" in sql
    assert "LIMIT 10" in sql
    assert params == ("Electronics",)

def test_query_mongo_compiler():
    builder = Product.find().where("category", "=", "Books")
    filters, projection, limit = QueryCompiler.compile_to_mongo(builder.ast)
    
    assert filters == {"category": {"$eq": "Books"}}
    assert "id" in projection
    assert "name" in projection

def test_query_elasticsearch_compiler():
    builder = Product.find().where("category", "=", "Electronics").limit(5)
    body, limit = QueryCompiler.compile_to_elasticsearch(builder.ast)
    assert body == {"query": {"term": {"category": "Electronics"}}, "_source": ["id", "name", "category"]}
    assert limit == 5

def test_query_vector_compiler():
    builder = Product.find().vector_search("embedding", [0.1, 0.2], 3).where("category", "=", "Books")
    vector, filters, limit = QueryCompiler.compile_to_vector_query(builder.ast)
    assert vector == [0.1, 0.2]
    assert filters == {"category": "Books"}
    assert limit == 3
