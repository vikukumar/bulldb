using System;
using System.Collections.Generic;
using System.Linq;
using System.Linq.Expressions;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;

namespace BullDB
{
    public class QueryBuilder<T> where T : BaseModel, new()
    {
        private readonly MultiDatabase _db;
        private readonly string _tableName;
        private readonly List<string> _wheres = new List<string>();
        private readonly List<object> _args = new List<object>();
        private int _limit = -1;

        public QueryBuilder()
        {
            _db = BaseModel.Database;
            _tableName = BaseModel.GetMetadata(typeof(T)).TableName;
            SecurityEngine.InjectRls(this);
        }

        public QueryBuilder<T> Where(string field, string op, object val)
        {
            _wheres.Add($"{field.ToLower()} {op} ?");
            _args.Add(val);
            return this;
        }

        public QueryBuilder<T> Where(Expression<Func<T, bool>> predicate)
        {
            if (predicate.Body is BinaryExpression binary)
            {
                var field = GetFieldName(binary.Left);
                var op = GetOperator(binary.NodeType);
                var val = GetValue(binary.Right);
                return Where(field, op, val);
            }
            throw new NotSupportedException("Only binary expressions are supported (e.g. u => u.Email == \"val\")");
        }

        public QueryBuilder<T> Limit(int val)
        {
            _limit = val;
            return this;
        }

        public QueryBuilder<T> VectorSearch(string field, double[] vec, int limit)
        {
            _wheres.Add($"COSINE_SIMILARITY({field.ToLower()}, ?) > 0.8");
            
            // Serialize vector to comma-separated JSON string
            var sb = new StringBuilder();
            sb.Append("[");
            for (int i = 0; i < vec.Length; i++)
            {
                sb.Append(vec[i].ToString(System.Globalization.CultureInfo.InvariantCulture));
                if (i < vec.Length - 1) sb.Append(",");
            }
            sb.Append("]");
            _args.Add(sb.ToString());

            _limit = limit;
            return this;
        }

        public async Task<List<T>> ExecuteAsync()
        {
            // Auto Intelligence: Warn/guard against large or unconstrained queries
            if (_limit < 0 || _limit > 10000)
            {
                Console.WriteLine($"[Query Intelligence] Query on table \"{_tableName}\" is unconstrained or has a very large limit. Consider adding a smaller LIMIT to optimize performance and prevent memory exhaustion.");
            }

            // Auto Intelligence: Record query for N+1 detection
            N1QueryDetector.Instance.RecordQuery(_tableName);

            var sql = $"SELECT * FROM {_tableName}";
            if (_wheres.Count > 0)
            {
                sql += " WHERE " + string.Join(" AND ", _wheres);
            }
            if (_limit >= 0)
            {
                sql += $" LIMIT {_limit}";
            }

            var rows = await _db.ExecuteAsync(sql, _args.ToArray());
            var results = new List<T>();

            var type = typeof(T);
            var props = type.GetProperties(BindingFlags.Public | BindingFlags.Instance);

            foreach (var row in rows)
            {
                var item = new T();
                foreach (var prop in props)
                {
                    var colName = prop.Name.ToLower();
                    if (row.TryGetValue(colName, out var dbVal) && dbVal != null)
                    {
                        var encryptAttr = prop.GetCustomAttribute<EncryptAttribute>();
                        if (encryptAttr != null && dbVal is string cipher)
                        {
                            dbVal = SecurityEngine.DecryptField(cipher);
                        }

                        if (prop.PropertyType == typeof(int) && dbVal is long l)
                        {
                            prop.SetValue(item, (int)l);
                        }
                        else if (prop.PropertyType == typeof(int) && dbVal is double d)
                        {
                            prop.SetValue(item, (int)d);
                        }
                        else if (prop.PropertyType == typeof(double[]) && dbVal is string jsonVec)
                        {
                            try
                            {
                                var clean = jsonVec.Trim('[', ']');
                                if (!string.IsNullOrEmpty(clean))
                                {
                                    var parts = clean.Split(',');
                                    var doubleVec = new double[parts.Length];
                                    for (int i = 0; i < parts.Length; i++)
                                    {
                                        doubleVec[i] = double.Parse(parts[i], System.Globalization.CultureInfo.InvariantCulture);
                                    }
                                    prop.SetValue(item, doubleVec);
                                }
                            }
                            catch { }
                        }
                        else
                        {
                            prop.SetValue(item, dbVal);
                        }
                    }
                }
                results.Add(item);
            }

            return results;
        }

        private string GetFieldName(Expression expr)
        {
            if (expr is MemberExpression member) return member.Member.Name;
            if (expr is UnaryExpression unary && unary.Operand is MemberExpression uMember) return uMember.Member.Name;
            throw new InvalidOperationException("Invalid field expression");
        }

        private string GetOperator(ExpressionType nodeType)
        {
            return nodeType switch
            {
                ExpressionType.Equal => "=",
                ExpressionType.NotEqual => "!=",
                ExpressionType.LessThan => "<",
                ExpressionType.LessThanOrEqual => "<=",
                ExpressionType.GreaterThan => ">",
                ExpressionType.GreaterThanOrEqual => ">=",
                _ => throw new NotSupportedException($"Operator {nodeType} not supported")
            };
        }

        private object GetValue(Expression expr)
        {
            if (expr is ConstantExpression constant) return constant.Value!;
            var objectMember = Expression.Convert(expr, typeof(object));
            var getterLambda = Expression.Lambda<Func<object>>(objectMember);
            var getter = getterLambda.Compile();
            return getter();
        }
    }
}
