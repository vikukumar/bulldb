import { ModelMetadataRegistry } from "./models";
import { SecurityEngine } from "./security";

export abstract class ASTNode {}

export class ValueNode extends ASTNode {
  constructor(public value: any) { super(); }
}

export class ColumnNode extends ASTNode {
  constructor(public name: string) { super(); }
}

export class BinaryOpNode extends ASTNode {
  constructor(public left: ASTNode, public op: string, public right: ASTNode) { super(); }
}

export class SelectAST extends ASTNode {
  public table = "";
  public fields: string[] = [];
  public filters: ASTNode | null = null;
  public joins: [string, string, string][] = []; // target_table, on_left, on_right
  public orderBy: string[] = [];
  public limit: number | null = null;
  public offset: number | null = null;
  public vectorSearch: [string, number[], number] | null = null; // field, query_vector, limit
  public ctes: [string, SelectAST][] = [];
}

export class QueryCompiler {
  static compileToSql(ast: SelectAST): [string, any[]] {
    const params: any[] = [];
    
    // 1. CTE Compilation
    let ctePrefix = "";
    if (ast.ctes.length > 0) {
      const parts = ast.ctes.map(([name, cteAst]) => {
        const [subSql, subParams] = this.compileToSql(cteAst);
        params.push(...subParams);
        return `${name} AS (${subSql})`;
      });
      ctePrefix = `WITH ${parts.join(", ")} `;
    }

    const fieldsStr = ast.fields.length > 0 ? ast.fields.join(", ") : "*";
    let sql = `${ctePrefix}SELECT ${fieldsStr} FROM ${ast.table}`;

    // Joins
    for (const [target, left, right] of ast.joins) {
      sql += ` JOIN ${target} ON ${ast.table}.${left} = ${target}.${right}`;
    }

    // Where filters
    if (ast.filters) {
      const [whereSql, whereParams] = this.compileFilterSql(ast.filters);
      sql += ` WHERE ${whereSql}`;
      params.push(...whereParams);
    }

    // Vector query additions
    if (ast.vectorSearch) {
      const [field, vector, limit] = ast.vectorSearch;
      sql += ` ORDER BY ${field} <=> ?`;
      params.push(JSON.stringify(vector));
      if (ast.limit === null) {
        ast.limit = limit;
      }
    }

    // Order By
    if (ast.orderBy.length > 0) {
      sql += ` ORDER BY ${ast.orderBy.join(", ")}`;
    }

    // Limit / Offset
    if (ast.limit !== null) sql += ` LIMIT ${ast.limit}`;
    if (ast.offset !== null) sql += ` OFFSET ${ast.offset}`;

    return [sql, params];
  }

  private static compileFilterSql(node: ASTNode): [string, any[]] {
    if (node instanceof ValueNode) {
      return ["?", [node.value]];
    }
    if (node instanceof ColumnNode) {
      return [node.name, []];
    }
    if (node instanceof BinaryOpNode) {
      const [leftSql, leftParams] = this.compileFilterSql(node.left);
      const [rightSql, rightParams] = this.compileFilterSql(node.right);
      return [`(${leftSql} ${node.op} ${rightSql})`, [...leftParams, ...rightParams]];
    }
    return ["", []];
  }

  static compileToMongo(ast: SelectAST): [Record<string, any>, Record<string, any>, number | null] {
    const filters = ast.filters ? this.compileFilterMongo(ast.filters) : {};
    const projection: Record<string, any> = {};
    for (const field of ast.fields) {
      projection[field] = 1;
    }
    return [filters, projection, ast.limit];
  }

  private static compileFilterMongo(node: ASTNode): Record<string, any> {
    if (node instanceof BinaryOpNode) {
      const { left, op, right } = node;
      if (left instanceof ColumnNode && right instanceof ValueNode) {
        const opMap: Record<string, string> = {
          "=": "$eq",
          "!=": "$ne",
          ">": "$gt",
          "<": "$lt",
          ">=": "$gte",
          "<=": "$lte"
        };
        const mongoOp = opMap[op] || "$eq";
        return { [left.name]: { [mongoOp]: right.value } };
      }
      if (["AND", "OR"].includes(op.toUpperCase())) {
        const key = op.toUpperCase() === "AND" ? "$and" : "$or";
        return { [key]: [this.compileFilterMongo(left), this.compileFilterMongo(right)] };
      }
    }
    return {};
  }

  static compileToCypher(ast: SelectAST): [string, Record<string, any>] {
    const params: Record<string, any> = {};
    const match = `(n:${ast.table})`;
    let whereStr = "";
    if (ast.filters) {
      const [cyFilter, cyParams] = this.compileFilterCypher(ast.filters);
      whereStr = ` WHERE ${cyFilter}`;
      Object.assign(params, cyParams);
    }
    const returnFields = ast.fields.length > 0 ? ast.fields.map(f => `n.${f}`).join(", ") : "n";
    let cypher = `MATCH ${match}${whereStr} RETURN ${returnFields}`;
    if (ast.limit !== null) {
      cypher += ` LIMIT ${ast.limit}`;
    }
    return [cypher, params];
  }

  private static compileFilterCypher(node: ASTNode): [string, Record<string, any>] {
    if (node instanceof BinaryOpNode) {
      const { left, op, right } = node;
      if (left instanceof ColumnNode && right instanceof ValueNode) {
        const paramName = `val_${left.name}`;
        const cyOp = op === "=" ? "==" : op;
        return [`n.${left.name} ${cyOp} $${paramName}`, { [paramName]: right.value }];
      }
    }
    return ["", {}];
  }

  static compileToElasticsearch(ast: SelectAST): [Record<string, any>, number] {
    let queryBody: Record<string, any> = { query: { match_all: {} } };
    if (ast.filters) {
      queryBody = { query: this.compileFilterEs(ast.filters) };
    }
    if (ast.fields.length > 0) {
      queryBody._source = ast.fields;
    }
    return [queryBody, ast.limit || 10];
  }

  private static compileFilterEs(node: ASTNode): Record<string, any> {
    if (node instanceof BinaryOpNode) {
      const { left, op, right } = node;
      if (left instanceof ColumnNode && right instanceof ValueNode) {
        if (op === "=") {
          return { term: { [left.name]: right.value } };
        } else if (op === "!=") {
          return { bool: { must_not: [{ term: { [left.name]: right.value } }] } };
        } else if ([">", "<", ">=", "<="].includes(op)) {
          const esOp = { ">": "gt", "<": "lt", ">=": "gte", "<=": "lte" }[op] as string;
          return { range: { [left.name]: { [esOp]: right.value } } };
        }
      }
      if (op.toUpperCase() === "AND") {
        return { bool: { must: [this.compileFilterEs(left), this.compileFilterEs(right)] } };
      }
      if (op.toUpperCase() === "OR") {
        return { bool: { should: [this.compileFilterEs(left), this.compileFilterEs(right)] } };
      }
    }
    return { match_all: {} };
  }

  static compileToVectorQuery(ast: SelectAST): [number[] | null, Record<string, any>, number] {
    const filters = ast.filters ? this.compileFilterVector(ast.filters) : {};
    let vector: number[] | null = null;
    let limit = ast.limit || 5;
    if (ast.vectorSearch) {
      [, vector, limit] = ast.vectorSearch;
    }
    return [vector, filters, limit];
  }

  private static compileFilterVector(node: ASTNode): Record<string, any> {
    if (node instanceof BinaryOpNode) {
      const { left, op, right } = node;
      if (left instanceof ColumnNode && right instanceof ValueNode) {
        return { [left.name]: right.value };
      }
      const res: Record<string, any> = {};
      Object.assign(res, this.compileFilterVector(left));
      Object.assign(res, this.compileFilterVector(right));
      return res;
    }
    return {};
  }
}

export class QueryBuilder<T> {
  public ast = new SelectAST();

  constructor(private modelClass: any) {
    this.ast.table = ModelMetadataRegistry.getTableName(modelClass.name);
    const fields = ModelMetadataRegistry.getFields(modelClass.name);
    this.ast.fields = Array.from(fields.keys());
  }

  select(...fields: string[]): this {
    this.ast.fields = fields;
    return this;
  }

  where(field: string, op: string, value: any): this {
    const cond = new BinaryOpNode(new ColumnNode(field), op, new ValueNode(value));
    if (this.ast.filters) {
      this.ast.filters = new BinaryOpNode(this.ast.filters, "AND", cond);
    } else {
      this.ast.filters = cond;
    }
    return this;
  }

  andWhere(field: string, op: string, value: any): this {
    return this.where(field, op, value);
  }

  orWhere(field: string, op: string, value: any): this {
    const cond = new BinaryOpNode(new ColumnNode(field), op, new ValueNode(value));
    if (this.ast.filters) {
      this.ast.filters = new BinaryOpNode(this.ast.filters, "OR", cond);
    } else {
      this.ast.filters = cond;
    }
    return this;
  }

  join(targetTable: string, onLeft: string, onRight: string): this {
    this.ast.joins.push([targetTable, onLeft, onRight]);
    return this;
  }

  orderBy(field: string, direction: "ASC" | "DESC" = "ASC"): this {
    const dir = direction === "DESC" ? " DESC" : "";
    this.ast.orderBy.push(`${field}${dir}`);
    return this;
  }

  limit(limitVal: number): this {
    this.ast.limit = limitVal;
    return this;
  }

  offset(offsetVal: number): this {
    this.ast.offset = offsetVal;
    return this;
  }

  vectorSearch(field: string, queryVector: number[], limit = 5): this {
    this.ast.vectorSearch = [field, queryVector, limit];
    return this;
  }

  withCte(cteName: string, subquery: QueryBuilder<any>): this {
    this.ast.ctes.push([cteName, subquery.ast]);
    return this;
  }

  async execute(): Promise<T[]> {
    const db = this.modelClass.db;
    if (!db) {
      throw new Error("No database client registered. Call setDb() on model class first.");
    }

    const driver = db.getRoute(this.ast.table);
    const dialect = driver.name;

    // Inject RLS parameters
    SecurityEngine.injectRls(this.ast);

    let results: any[] = [];
    if (dialect.includes("mongo")) {
      const [filters, projection, limit] = QueryCompiler.compileToMongo(this.ast);
      if (typeof (driver as any).executeMongoFind === "function") {
        results = await (driver as any).executeMongoFind(this.ast.table, filters, projection, limit);
      } else {
        results = await driver.execute(JSON.stringify({ filters, projection, limit }));
      }
    } else if (dialect.includes("elasticsearch")) {
      const [body, limit] = QueryCompiler.compileToElasticsearch(this.ast);
      if (typeof (driver as any).executeSearch === "function") {
        results = await (driver as any).executeSearch(this.ast.table, body, limit);
      } else {
        results = await driver.execute(JSON.stringify({ body, limit }));
      }
    } else if (dialect.includes("vector") || dialect.includes("chroma") || dialect.includes("pinecone")) {
      const [vector, filters, limit] = QueryCompiler.compileToVectorQuery(this.ast);
      if (typeof (driver as any).executeVectorSearch === "function") {
        results = await (driver as any).executeVectorSearch(this.ast.table, vector, filters, limit);
      } else {
        results = await driver.execute(JSON.stringify({ vector, filters, limit }));
      }
    } else if (dialect.includes("neo4j")) {
      const [cypher, params] = QueryCompiler.compileToCypher(this.ast);
      results = await driver.execute(cypher, Object.values(params));
    } else {
      // SQL fallback
      const [sql, params] = QueryCompiler.compileToSql(this.ast);
      results = await driver.execute(sql, params);
    }

    return results.map(row => new this.modelClass(row));
  }
}
