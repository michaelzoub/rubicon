// Minimal ambient declaration for the optional `pg` driver. The Postgres
// adapter is only loaded at runtime when DATABASE_URL is configured, so `pg`
// does not need to be installed to build or run the in-memory/dev path.
declare module "pg" {
  export interface QueryResult<R = Record<string, unknown>> {
    rows: R[];
    rowCount: number;
  }
  export interface PoolClient {
    query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
    release(): void;
  }
  export class Pool {
    constructor(config?: { connectionString?: string; max?: number; ssl?: { rejectUnauthorized?: boolean } });
    query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
  }
}
