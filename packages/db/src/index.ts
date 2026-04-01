import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

export * from "./d1";
export * from "./d1-sql";

export interface DbClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

type CreateWranglerD1DbOptions = {
  cwd?: string;
  databaseName?: string;
  wranglerConfig?: string | null;
  remote?: boolean;
};

type WranglerStatementResult<T> = {
  results?: T[];
  success?: boolean;
  meta?: Record<string, unknown>;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableD1Error(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /code:\s*971/u.test(message) || /consider throttling your request speed/iu.test(message);
}

function sqliteLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot serialize non-finite number ${value} for D1.`);
    }
    return String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  if (typeof value === "string") {
    return `'${value.replace(/'/gu, "''")}'`;
  }
  if (value instanceof Date) {
    return sqliteLiteral(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `(${value.map((entry) => sqliteLiteral(entry)).join(", ") || "NULL"})`;
  }
  return sqliteLiteral(JSON.stringify(value));
}

function interpolateSql(sql: string, params: unknown[] = []) {
  if (/\$\d+/u.test(sql)) {
    let rendered = sql;
    for (let index = params.length; index >= 1; index -= 1) {
      const pattern = new RegExp(`\\$${index}(?!\\d)`, "gu");
      rendered = rendered.replace(pattern, sqliteLiteral(params[index - 1]));
    }
    return rendered;
  }
  if (sql.includes("?")) {
    let paramIndex = 0;
    return sql.replace(/\?/gu, () => {
      const value = paramIndex < params.length ? params[paramIndex] : null;
      paramIndex += 1;
      return sqliteLiteral(value);
    });
  }
  return sql;
}

async function runWranglerJson<T>(
  args: string[],
  options: { cwd: string },
): Promise<T> {
  return await new Promise<T>((resolvePromise, reject) => {
    const child = spawn("npx", ["wrangler", ...args], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
        reject(new Error(details || `wrangler ${args.join(" ")} exited with code ${code ?? -1}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout) as T);
      } catch (error) {
        reject(new Error(`Failed to parse wrangler JSON output: ${error instanceof Error ? error.message : String(error)}\n${stdout}`));
      }
    });
  });
}

export function createWranglerD1Db(options: CreateWranglerD1DbOptions = {}): DbClient {
  const cwd = resolve(options.cwd ?? process.cwd());
  const databaseName = options.databaseName ?? process.env.D1_DATABASE_NAME ?? "alphabook-app";
  const remoteFlag = options.remote === false ? "--local" : "--remote";

  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const command = interpolateSql(sql, params).replace(/\r?\n\s*/gu, " ").trim();
      const args = ["d1", "execute", databaseName, remoteFlag, "--json", "--command", command];
      if (options.wranglerConfig) {
        args.push("--config", options.wranglerConfig);
      }
      let output: WranglerStatementResult<T>[] | null = null;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          output = await runWranglerJson<WranglerStatementResult<T>[]>(args, { cwd });
          break;
        } catch (error) {
          lastError = error;
          if (!isRetryableD1Error(error) || attempt === 4) {
            throw error;
          }
          await sleep(1000 * 2 ** attempt);
        }
      }
      if (!output) {
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
      }
      const statement = output.find((entry) => entry.success !== false) ?? output[0];
      if (!statement || statement.success === false) {
        throw new Error(`D1 query failed for ${databaseName}.`);
      }
      return {
        rows: Array.isArray(statement.results) ? statement.results : [],
      };
    },
    async end() {
      return Promise.resolve();
    },
  };
}

export async function runMigrations(): Promise<void> {
  const schemaPath = await mkdtemp(join(tmpdir(), "alphabook-d1-schema-"));
  const file = join(schemaPath, "schema.sql");
  try {
    const { D1_SCHEMA_SQL } = await import("./d1-sql");
    await writeFile(file, `${D1_SCHEMA_SQL.trim()}\n`, "utf8");
    await runWranglerJson(["d1", "execute", process.env.D1_DATABASE_NAME ?? "alphabook-app", "--remote", "--json", "--file", file], {
      cwd: process.cwd(),
    });
  } finally {
    await rm(schemaPath, { recursive: true, force: true });
  }
}

export async function loadLocalDevVars(cwd = process.cwd()) {
  try {
    const envText = await readFile(resolve(cwd, ".dev.vars"), "utf8");
    for (const line of envText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const match = trimmed.match(/^([A-Z0-9_]+)=(.*)$/u);
      if (!match) {
        continue;
      }
      const [, key, rawValue] = match;
      if (Object.prototype.hasOwnProperty.call(process.env, key)) {
        continue;
      }
      process.env[key] = rawValue.trim().replace(/^"(.*)"$/u, "$1").replace(/^'(.*)'$/u, "$1");
    }
  } catch {
    return;
  }
}
