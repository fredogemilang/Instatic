export interface DbResult<Row = Record<string, unknown>> {
  rows: Row[]
  rowCount: number
}

/** Which SQL dialect the backing database speaks. */
export type Dialect = 'postgres' | 'sqlite'

/**
 * The shared DB client interface. Used by repositories and handlers.
 * Tagged-template callable returning DbResult, plus:
 *   - .unsafe(...) — execute raw SQL strings (e.g. stored migration blocks)
 *   - .transaction(fn) — runs a callback inside a DB transaction
 *   - .dialect      — which SQL dialect the backing database speaks
 */
export interface DbClient {
  <Row = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>>
  unsafe<Row = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<DbResult<Row>>
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>
  readonly dialect: Dialect
}
