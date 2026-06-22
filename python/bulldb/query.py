from typing import Any, Dict, List, Optional, Tuple, Type, Union

class ASTNode:
    pass

class ValueNode(ASTNode):
    def __init__(self, value: Any):
        self.value = value

class ColumnNode(ASTNode):
    def __init__(self, name: str):
        self.name = name

class BinaryOpNode(ASTNode):
    def __init__(self, left: ASTNode, op: str, right: ASTNode):
        self.left = left
        self.op = op
        self.right = right

class SelectAST(ASTNode):
    def __init__(self):
        self.table: str = ""
        self.fields: List[str] = []
        self.filters: Optional[ASTNode] = None
        self.joins: List[Tuple[str, str, str]] = [] # target_table, on_left, on_right
        self.order_by: List[str] = []
        self.limit: Optional[int] = None
        self.offset: Optional[int] = None
        self.vector_search: Optional[Tuple[str, List[float], int]] = None # field, query_vector, limit
        self.ctes: List[Tuple[str, 'SelectAST']] = []

class QueryCompiler:
    @staticmethod
    def compile_to_sql(ast: SelectAST) -> Tuple[str, tuple]:
        params = []
        
        # Compile CTEs
        cte_parts = []
        for cte_name, cte_ast in ast.ctes:
            sub_sql, sub_params = QueryCompiler.compile_to_sql(cte_ast)
            cte_parts.append(f"{cte_name} AS ({sub_sql})")
            params.extend(sub_params)
        cte_prefix = f"WITH {', '.join(cte_parts)} " if cte_parts else ""

        # Fields
        fields_str = ", ".join(ast.fields) if ast.fields else "*"
        
        # Base Query
        sql = f"{cte_prefix}SELECT {fields_str} FROM {ast.table}"
        
        # Joins
        for target, left, right in ast.joins:
            sql += f" JOIN {target} ON {ast.table}.{left} = {target}.{right}"
            
        # Where filters
        if ast.filters:
            where_sql, where_params = QueryCompiler._compile_filter_sql(ast.filters)
            sql += f" WHERE {where_sql}"
            params.extend(where_params)

        # Vector search fallback ordering (e.g. pgvector)
        if ast.vector_search:
            field, vector, limit = ast.vector_search
            # Postgres pgvector operator for cosine distance is <=>
            sql += f" ORDER BY {field} <=> %s"
            params.append(str(vector))
            if not ast.limit:
                ast.limit = limit

        # Order by
        if ast.order_by:
            sql += f" ORDER BY {', '.join(ast.order_by)}"
            
        # Limit / Offset
        if ast.limit is not None:
            sql += f" LIMIT {ast.limit}"
        if ast.offset is not None:
            sql += f" OFFSET {ast.offset}"
            
        return sql, tuple(params)

    @staticmethod
    def _compile_filter_sql(node: ASTNode) -> Tuple[str, list]:
        if isinstance(node, ValueNode):
            return "?", [node.value]
        if isinstance(node, ColumnNode):
            return node.name, []
        if isinstance(node, BinaryOpNode):
            left_sql, left_params = QueryCompiler._compile_filter_sql(node.left)
            right_sql, right_params = QueryCompiler._compile_filter_sql(node.right)
            return f"({left_sql} {node.op} {right_sql})", left_params + right_params
        return "", []

    @staticmethod
    def compile_to_mongo(ast: SelectAST) -> Tuple[Dict[str, Any], Dict[str, Any], Optional[int]]:
        # Returns (filter_query, projection, limit)
        filters = {}
        if ast.filters:
            filters = QueryCompiler._compile_filter_mongo(ast.filters)
            
        projection = {f: 1 for f in ast.fields} if ast.fields else {}
        return filters, projection, ast.limit

    @staticmethod
    def _compile_filter_mongo(node: ASTNode) -> Dict[str, Any]:
        if isinstance(node, BinaryOpNode):
            # Parse field and value
            left = node.left
            right = node.right
            if isinstance(left, ColumnNode) and isinstance(right, ValueNode):
                field = left.name
                val = right.value
                op_map = {"=": "$eq", "!=": "$ne", ">": "$gt", "<": "$lt", ">=": "$gte", "<=": "$lte"}
                mongo_op = op_map.get(node.op, "$eq")
                return {field: {mongo_op: val}}
            # Compound AND/OR
            if node.op.upper() in ("AND", "OR"):
                left_mongo = QueryCompiler._compile_filter_mongo(left)
                right_mongo = QueryCompiler._compile_filter_mongo(right)
                key = "$and" if node.op.upper() == "AND" else "$or"
                return {key: [left_mongo, right_mongo]}
        return {}

    @staticmethod
    def compile_to_cypher(ast: SelectAST) -> Tuple[str, dict]:
        # Returns cypher string and params dict
        params = {}
        match_pattern = f"(n:{ast.table})"
        where_clauses = []
        
        if ast.filters:
            cypher_filter, cypher_params = QueryCompiler._compile_filter_cypher(ast.filters)
            where_clauses.append(cypher_filter)
            params.update(cypher_params)
            
        where_str = f" WHERE {', '.join(where_clauses)}" if where_clauses else ""
        return_fields = ", ".join([f"n.{f}" for f in ast.fields]) if ast.fields else "n"
        
        cypher = f"MATCH {match_pattern}{where_str} RETURN {return_fields}"
        if ast.limit:
            cypher += f" LIMIT {ast.limit}"
            
        return cypher, params

    @staticmethod
    def _compile_filter_cypher(node: ASTNode) -> Tuple[str, dict]:
        if isinstance(node, BinaryOpNode):
            left = node.left
            right = node.right
            if isinstance(left, ColumnNode) and isinstance(right, ValueNode):
                field = left.name
                param_name = f"val_{field}"
                op = node.op
                if op == "=": op = "=="
                return f"n.{field} {op} ${param_name}", {param_name: right.value}
        return "", {}

    @staticmethod
    def compile_to_elasticsearch(ast: SelectAST) -> Tuple[Dict[str, Any], int]:
        query_body = {"query": {"match_all": {}}}
        if ast.filters:
            query_body = {"query": QueryCompiler._compile_filter_es(ast.filters)}
        if ast.fields:
            query_body["_source"] = ast.fields
        return query_body, ast.limit or 10

    @staticmethod
    def _compile_filter_es(node: ASTNode) -> Dict[str, Any]:
        if isinstance(node, BinaryOpNode):
            left = node.left
            right = node.right
            if isinstance(left, ColumnNode) and isinstance(right, ValueNode):
                field = left.name
                val = right.value
                if node.op == "=":
                    return {"term": {field: val}}
                elif node.op == "!=":
                    return {"bool": {"must_not": [{"term": {field: val}}]}}
                elif node.op in (">", "<", ">=", "<="):
                    es_op = {">": "gt", "<": "lt", ">=": "gte", "<=": "lte"}[node.op]
                    return {"range": {field: {es_op: val}}}
            if node.op.upper() == "AND":
                return {"bool": {"must": [QueryCompiler._compile_filter_es(left), QueryCompiler._compile_filter_es(right)]}}
            if node.op.upper() == "OR":
                return {"bool": {"should": [QueryCompiler._compile_filter_es(left), QueryCompiler._compile_filter_es(right)]}}
        return {"match_all": {}}

    @staticmethod
    def compile_to_vector_query(ast: SelectAST) -> Tuple[Optional[List[float]], Dict[str, Any], int]:
        filters = {}
        if ast.filters:
            filters = QueryCompiler._compile_filter_vector(ast.filters)
        vector = None
        limit = ast.limit or 5
        if ast.vector_search:
            _, vector, limit = ast.vector_search
        return vector, filters, limit

    @staticmethod
    def _compile_filter_vector(node: ASTNode) -> Dict[str, Any]:
        if isinstance(node, BinaryOpNode):
            left = node.left
            right = node.right
            if isinstance(left, ColumnNode) and isinstance(right, ValueNode):
                return {left.name: right.value}
            res = {}
            res.update(QueryCompiler._compile_filter_vector(left))
            res.update(QueryCompiler._compile_filter_vector(right))
            return res
        return {}

class QueryBuilder:
    def __init__(self, model_class: Type):
        self.model_class = model_class
        self.ast = SelectAST()
        self.ast.table = model_class._table_name
        self.ast.fields = list(model_class._fields.keys())

    def select(self, *fields: str) -> "QueryBuilder":
        self.ast.fields = list(fields)
        return self

    def where(self, field: str, op: str, value: Any) -> "QueryBuilder":
        new_filter = BinaryOpNode(ColumnNode(field), op, ValueNode(value))
        if self.ast.filters:
            self.ast.filters = BinaryOpNode(self.ast.filters, "AND", new_filter)
        else:
            self.ast.filters = new_filter
        return self

    def and_where(self, field: str, op: str, value: Any) -> "QueryBuilder":
        return self.where(field, op, value)

    def or_where(self, field: str, op: str, value: Any) -> "QueryBuilder":
        new_filter = BinaryOpNode(ColumnNode(field), op, ValueNode(value))
        if self.ast.filters:
            self.ast.filters = BinaryOpNode(self.ast.filters, "OR", new_filter)
        else:
            self.ast.filters = new_filter
        return self

    def join(self, target_table: str, on_left: str, on_right: str) -> "QueryBuilder":
        self.ast.joins.append((target_table, on_left, on_right))
        return self

    def order_by(self, field: str, direction: str = "ASC") -> "QueryBuilder":
        suffix = f" {direction}" if direction.upper() == "DESC" else ""
        self.ast.order_by.append(f"{field}{suffix}")
        return self

    def limit(self, limit_val: int) -> "QueryBuilder":
        self.ast.limit = limit_val
        return self

    def offset(self, offset_val: int) -> "QueryBuilder":
        self.ast.offset = offset_val
        return self

    def vector_search(self, field: str, query_vector: List[float], limit: int = 5) -> "QueryBuilder":
        self.ast.vector_search = (field, query_vector, limit)
        return self

    def with_cte(self, cte_name: str, subquery: "QueryBuilder") -> "QueryBuilder":
        self.ast.ctes.append((cte_name, subquery.ast))
        return self

    async def execute(self) -> List[Any]:
        db = self.model_class._db
        if not db:
            raise ValueError("No database client registered. Connect to MultiDatabase first.")

        driver = db.get_route(self.ast.table)
        dialect = driver.name

        from .security import SecurityEngine
        SecurityEngine.inject_rls(self.ast)

        results = []
        if "mongo" in dialect:
            filters, projection, limit = QueryCompiler.compile_to_mongo(self.ast)
            mongo_results = await driver.execute_mongo_find(self.ast.table, filters, projection, limit)
            results = mongo_results
        elif "elasticsearch" in dialect:
            body, limit = QueryCompiler.compile_to_elasticsearch(self.ast)
            results = await driver.execute_search(self.ast.table, body, limit)
        elif "vector" in dialect or "chroma" in dialect or "pinecone" in dialect:
            vector, filters, limit = QueryCompiler.compile_to_vector_query(self.ast)
            results = await driver.execute_vector_search(self.ast.table, vector, filters, limit)
        elif "neo4j" in dialect:
            cypher, params = QueryCompiler.compile_to_cypher(self.ast)
            results = await driver.execute(cypher, tuple(params.values()))
        else:
            sql, params = QueryCompiler.compile_to_sql(self.ast)
            results = await driver.execute(sql, params)

        return [self.model_class(**res) for res in results]
