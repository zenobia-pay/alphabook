import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface VectorizeInfoResult {
  dimensions?: number;
  vectorCount?: number;
}

interface VectorizeListResult {
  vectors?: Array<{ id: string }>;
  nextCursor?: string;
  isTruncated?: boolean;
  totalCount?: number;
}

interface VectorizeGetResultItem {
  id?: string;
}

function isNoMatchingVectorWarning(stdout: string) {
  return /does not contain vectors corresponding to the provided identifiers/iu.test(stdout);
}

function hasJsonPayload(stdout: string) {
  return stdout.includes("{") || stdout.includes("[");
}

export class CloudflareVectorizeApi {
  constructor(
    private readonly wranglerConfigPath: string,
    private readonly cwd: string = process.cwd(),
  ) {}

  private async runWrangler(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("npx", ["wrangler", ...args], {
      cwd: this.cwd,
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout.trim();
  }

  private parseJson<T>(stdout: string): T {
    const objectStart = stdout.indexOf("{");
    const arrayStart = stdout.indexOf("[");
    const start = objectStart === -1
      ? arrayStart
      : (arrayStart === -1 ? objectStart : Math.min(objectStart, arrayStart));
    if (start === -1) {
      throw new Error(`Wrangler Vectorize output did not contain JSON: ${stdout}`);
    }
    return JSON.parse(stdout.slice(start)) as T;
  }

  async getInfo(indexName: string): Promise<VectorizeInfoResult> {
    const stdout = await this.runWrangler([
      "vectorize",
      "info",
      indexName,
      "--json",
      "--config",
      this.wranglerConfigPath,
    ]);
    return this.parseJson<VectorizeInfoResult>(stdout);
  }

  async listVectorIds(indexName: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    while (true) {
      const args = [
        "vectorize",
        "list-vectors",
        indexName,
        "--count",
        "1000",
        "--json",
        "--config",
        this.wranglerConfigPath,
      ];
      if (cursor) {
        args.push("--cursor", cursor);
      }
      const stdout = await this.runWrangler(args);
      const result = this.parseJson<VectorizeListResult>(stdout);
      ids.push(...(result.vectors ?? []).map((vector) => vector.id));
      if (!result.isTruncated || !result.nextCursor) {
        break;
      }
      cursor = result.nextCursor;
    }
    return ids;
  }

  async getVectorIds(indexName: string, ids: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (let index = 0; index < ids.length; index += 20) {
      const batch = ids.slice(index, index + 20);
      if (batch.length === 0) {
        continue;
      }
      const stdout = await this.runWrangler([
        "vectorize",
        "get-vectors",
        indexName,
        ...batch.flatMap((id) => ["--ids", id]),
        "--config",
        this.wranglerConfigPath,
      ]);
      if (isNoMatchingVectorWarning(stdout) || !hasJsonPayload(stdout)) {
        continue;
      }
      const result = this.parseJson<VectorizeGetResultItem[]>(stdout);
      for (const vector of result) {
        if (vector.id) {
          found.add(vector.id);
        }
      }
    }
    return found;
  }

  async deleteVectorIds(indexName: string, ids: string[]): Promise<void> {
    for (let index = 0; index < ids.length; index += 100) {
      const batch = ids.slice(index, index + 100);
      if (batch.length === 0) {
        continue;
      }
      await this.runWrangler([
        "vectorize",
        "delete-vectors",
        indexName,
        ...batch.flatMap((id) => ["--ids", id]),
        "--config",
        this.wranglerConfigPath,
      ]);
    }
  }
}
