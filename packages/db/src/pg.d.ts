declare module "pg" {
  export type PoolConfig = Record<string, unknown>;
  export class Pool {
    constructor(config?: PoolConfig);
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
    end(): Promise<void>;
  }
}
