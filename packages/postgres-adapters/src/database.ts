export interface SqlQueryResult<TRow extends object> {
  readonly rows: readonly TRow[];
  readonly rowCount: number;
}

/**
 * Minimal contract intentionally compatible with common Postgres clients.
 * The application must inject an implementation; this package never opens a
 * connection or falls back to process memory.
 */
export interface PostgresTransaction {
  query<TRow extends object>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<TRow>>;
}

export interface PostgresExecutor {
  transaction<TResult>(
    work: (transaction: PostgresTransaction) => Promise<TResult>,
  ): Promise<TResult>;
}

export function readIsoTimestamp(
  value: string | Date,
  field: string,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new TypeError(`Postgres returned an invalid ${field} timestamp.`);
  }
  return date.toISOString();
}
