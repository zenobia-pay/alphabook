export function parseModelJsonObject<T>(content: string): T {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const firstBrace = trimmed.indexOf("{");
    if (firstBrace < 0) {
      throw new Error("Model response did not contain a JSON object.");
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = firstBrace; index < trimmed.length; index += 1) {
      const char = trimmed[index];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === "{") {
        depth += 1;
        continue;
      }

      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          return JSON.parse(trimmed.slice(firstBrace, index + 1)) as T;
        }
      }
    }

    throw new Error("Model response did not contain a complete JSON object.");
  }
}
