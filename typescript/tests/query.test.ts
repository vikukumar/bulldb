import { BaseModel, PrimaryKey, Unique, Field, UUID, Email, QueryCompiler } from "../src";

class Product extends BaseModel {
  @PrimaryKey()
  id!: string;

  @Field(Email())
  name!: string;
}

describe("TypeScript Query Compiler Suite", () => {
  it("should compile QueryBuilder AST into parameterized SQL queries", () => {
    const builder = Product.find().where("name", "=", "Electronics").limit(5);
    const [sql, params] = QueryCompiler.compileToSql(builder.ast);

    expect(sql).toContain("SELECT");
    expect(sql).toContain("FROM products");
    expect(sql).toContain("name = ?");
    expect(sql).toContain("LIMIT 5");
    expect(params).toEqual(["Electronics"]);
  });

  it("should compile QueryBuilder AST into MongoDB filter criteria objects", () => {
    const builder = Product.find().where("name", "=", "Books");
    const [filters, projection, limit] = QueryCompiler.compileToMongo(builder.ast);

    expect(filters).toEqual({ name: { $eq: "Books" } });
    expect(projection).toHaveProperty("id");
    expect(projection).toHaveProperty("name");
  });

  it("should compile QueryBuilder AST into Elasticsearch Search DSL format", () => {
    const builder = Product.find().where("name", "=", "Electronics").limit(5);
    const [body, limit] = QueryCompiler.compileToElasticsearch(builder.ast);

    expect(body).toEqual({
      query: { term: { name: "Electronics" } },
      _source: ["id", "name"]
    });
    expect(limit).toBe(5);
  });

  it("should compile QueryBuilder AST into Vector database search query format", () => {
    const builder = Product.find().vectorSearch("embedding", [0.1, 0.2], 3).where("name", "=", "Books");
    const [vector, filters, limit] = QueryCompiler.compileToVectorQuery(builder.ast);

    expect(vector).toEqual([0.1, 0.2]);
    expect(filters).toEqual({ name: "Books" });
    expect(limit).toBe(3);
  });
});
