import { Database } from 'bun:sqlite'
import type { DbClient, DbResult } from './client'

type BindableValue = string | number | null | Uint8Array

/**
 * Convert an arbitrary JS value into something bun:sqlite can bind as a
 * positional parameter.
 *
 * - Plain objects / arrays → JSON.stringify (stored as TEXT)
 * - Date → ISO 8601 string
 * - Uint8Array / Buffer → pass through (stored as BLOB)
 * - boolean → 1 / 0
 * - string, number → pass through
 * - null / undefined → null
 */
function toBindable(value: unknown): BindableValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return value
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value as never)
}

/**
 * Expand a tagged template into a positional `?` SQL string plus a params
 * array, applying toBindable to every interpolated value.
 */
function renderTemplate(
  strings: TemplateStringsArray,
  values: unknown[],
): { sql: string; params: BindableValue[] } {
  let sql = ''
  const params: BindableValue[] = []
  for (let i = 0; i < strings.length; i++) {
    sql += strings[i]
    if (i < values.length) {
      sql += '?'
      params.push(toBindable(values[i]))
    }
  }
  return { sql, params }
}

/**
 * Walk every column in a returned row and JSON.parse any column whose name
 * ends in `_json` and whose value is a non-empty string. This mirrors the
 * automatic JSONB deserialization that Postgres does, so repository code does
 * not need to know which dialect it's talking to.
 */
function parseJsonColumns<Row>(row: Row): Row {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return row
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    if (key.endsWith('_json') && typeof value === 'string' && value.length > 0) {
      try {
        result[key] = JSON.parse(value)
      } catch {
        result[key] = value
      }
    } else {
      result[key] = value
    }
  }
  return result as Row
}

/**
 * Returns true for SQL that produces rows: SELECT queries and any statement
 * containing RETURNING (used by INSERT/UPDATE/DELETE … RETURNING in repos).
 */
function isSelectishStatement(sql: string): boolean {
  const trimmed = sql.trimStart()
  return /^select/i.test(trimmed) || /\breturning\b/i.test(sql)
}

export function createSqliteClient(filename: string): DbClient {
  const db = new Database(filename)

  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')

  const fn = (async <Row = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>> => {
    const { sql, params } = renderTemplate(strings, values)
    const stmt = db.prepare(sql)
    if (isSelectishStatement(sql)) {
      const rows = stmt.all(...params) as Row[]
      return { rows: rows.map(parseJsonColumns), rowCount: rows.length }
    }
    const info = stmt.run(...params)
    return { rows: [], rowCount: info.changes ?? 0 }
  }) as DbClient

  fn.unsafe = async <Row = Record<string, unknown>>(
    rawSql: string,
    params?: unknown[],
  ): Promise<DbResult<Row>> => {
    // Multi-statement migration blocks arrive as a single SQL string with
    // semicolons. db.exec() handles them correctly; prepare() + all() does not.
    if (params === undefined && rawSql.includes(';')) {
      db.exec(rawSql)
      return { rows: [], rowCount: 0 }
    }
    const stmt = db.prepare(rawSql)
    const bindParams = (params ?? []).map(toBindable)
    const rows = stmt.all(...bindParams) as Row[]
    return { rows: rows.map(parseJsonColumns), rowCount: rows.length }
  }

  // bun:sqlite is synchronous; simulate transactions with explicit
  // BEGIN / COMMIT / ROLLBACK via the same connection.
  fn.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> => {
    await fn.unsafe('BEGIN')
    try {
      const result = await cb(fn)
      await fn.unsafe('COMMIT')
      return result
    } catch (err) {
      try {
        await fn.unsafe('ROLLBACK')
      } catch {
        // swallow rollback failure — the original error is more important
      }
      throw err
    }
  }

  return Object.assign(fn, { dialect: 'sqlite' as const })
}
