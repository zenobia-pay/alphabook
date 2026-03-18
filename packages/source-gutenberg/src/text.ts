export function stripGutenbergBoilerplate(text: string): string {
  let normalized = text.replace(/\r\n/g, "\n");
  const startMatch = normalized.match(/^[^\n]*\*\*\*\s*START OF[\s\S]*?\*\*\*[^\n]*\n?/im);
  if (startMatch && typeof startMatch.index === "number") {
    normalized = normalized.slice(startMatch.index + startMatch[0].length);
  }

  const endMatch = normalized.match(/\n?[^\n]*\*\*\*\s*END OF[\s\S]*?\*\*\*[^\n]*$/im);
  if (endMatch && typeof endMatch.index === "number") {
    normalized = normalized.slice(0, endMatch.index);
  }

  return normalized
    .replace(/^\s*(?:start of )?the project gutenberg e(?:book|text).*$\n?/gim, "")
    .replace(/^\s*project gutenberg(?:'s)? e(?:book|text).*$\n?/gim, "")
    .trim();
}

export function normalizeCorpusText(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitOversizedSegment(segment: string, targetSize: number): string[] {
  const normalized = segment.trim();
  if (!normalized) {
    return [];
  }
  if (normalized.length <= targetSize) {
    return [normalized];
  }

  const pieces: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + targetSize, normalized.length);
    if (end < normalized.length) {
      const newline = normalized.lastIndexOf("\n", end);
      const whitespace = normalized.slice(start, end).search(/\s\S*$/);
      if (newline > start + Math.floor(targetSize * 0.5)) {
        end = newline;
      } else if (whitespace > 0) {
        end = start + whitespace;
      }
    }
    const piece = normalized.slice(start, end).trim();
    if (piece) {
      pieces.push(piece);
    }
    start = end;
    while (start < normalized.length && /\s/.test(normalized[start] ?? "")) {
      start += 1;
    }
  }
  return pieces;
}

export function chunkCorpusText(text: string, targetSize = 1400): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .flatMap((chunk) => splitOversizedSegment(chunk, targetSize))
    .filter(Boolean);
  const chunks: string[] = [];
  let buffer = "";
  for (const paragraph of paragraphs) {
    if ((buffer + "\n\n" + paragraph).length > targetSize && buffer) {
      chunks.push(buffer);
      buffer = paragraph;
      continue;
    }
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
  }
  if (buffer) {
    chunks.push(buffer);
  }
  return chunks;
}
