export interface CourtListenerCitation {
  cite?: string | null;
  type?: string | null;
}

export interface CourtListenerCluster {
  id: number;
  absolute_url?: string | null;
  case_name?: string | null;
  case_name_full?: string | null;
  date_filed?: string | null;
  docket?: string | null;
  docket_number?: string | null;
  judges?: string | null;
  citations?: CourtListenerCitation[] | null;
  precedential_status?: string | null;
  scdb_id?: string | null;
  slug?: string | null;
  sub_opinions?: string[] | null;
}

export interface CourtListenerOpinion {
  id: number;
  author_str?: string | null;
  cluster?: string | null;
  download_url?: string | null;
  html_with_citations?: string | null;
  local_path?: string | null;
  per_curiam?: boolean | null;
  plain_text?: string | null;
  type?: string | null;
}

export interface CourtListenerPaginatedResponse<T> {
  count?: number | string;
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface SupremeCourtCaseSourceRecord {
  externalId: string;
  title: string;
  rawSource: string;
  rawText: string;
  sourceFormat: "text" | "html";
  authors: string[];
  subjects: string[];
  releaseDate: string | null;
  rightsStatus: "public_domain";
  summary: string | null;
  sourceUrl: string | null;
  metadata: Record<string, unknown>;
}

const COURTLISTENER_API_BASE_URL = "https://www.courtlistener.com/api/rest/v3";
const COURTLISTENER_HOST = "https://www.courtlistener.com";

function normalizeCourtListenerUrl(value: string): string {
  if (/^https?:\/\//iu.test(value)) {
    return value;
  }
  return new URL(value, COURTLISTENER_HOST).toString();
}

function uniqueStrings(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const next = value?.trim();
    if (!next) {
      continue;
    }
    const key = next.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(next);
  }
  return normalized;
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;/giu, "'");
}

export function htmlToPlainText(value: string) {
  return decodeHtmlEntities(
    value
      .replace(/<\s*br\s*\/?>/giu, "\n")
      .replace(/<\/(?:p|div|section|article|blockquote|li|h[1-6]|tr)>/giu, "\n\n")
      .replace(/<[^>]+>/gu, " ")
      .replace(/\r\n/g, "\n"),
  )
    .replace(/\s+([,.;:!?])/gu, "$1")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n[ \t]+/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeOpinionType(value: string | null | undefined) {
  if (!value) {
    return "Opinion";
  }
  return value
    .replace(/^[0-9]+/u, "")
    .replaceAll("_", " ")
    .replace(/\s+/gu, " ")
    .trim() || "Opinion";
}

function opinionTypePriority(value: string | null | undefined) {
  const normalized = value?.toLowerCase() ?? "";
  if (normalized.includes("combined")) return 0;
  if (normalized.includes("majority")) return 1;
  if (normalized.includes("lead")) return 2;
  if (normalized.includes("plurality")) return 3;
  if (normalized.includes("concurr")) return 4;
  if (normalized.includes("dissent")) return 5;
  return 6;
}

function parseJudges(value: string | null | undefined) {
  if (!value) {
    return [];
  }
  return uniqueStrings(
    value
      .split(/[;,]|\band\b/giu)
      .map((entry) => entry.trim()),
  );
}

function normalizeCitations(citations: CourtListenerCitation[] | null | undefined) {
  return uniqueStrings(
    (citations ?? []).map((citation) => citation.cite ?? null),
  );
}

function buildSupremeCourtDocumentId(cluster: CourtListenerCluster) {
  return `courtlistener-cluster-${cluster.id}`;
}

function opinionHeader(opinion: CourtListenerOpinion, index: number) {
  const parts = [`Opinion ${index + 1}`];
  const type = normalizeOpinionType(opinion.type);
  if (type) {
    parts.push(type);
  }
  if (opinion.per_curiam) {
    parts.push("Per Curiam");
  } else if (opinion.author_str?.trim()) {
    parts.push(opinion.author_str.trim());
  }
  return parts.join(" - ");
}

function sortOpinions(opinions: CourtListenerOpinion[]) {
  return [...opinions].sort((left, right) => {
    const priorityDelta = opinionTypePriority(left.type) - opinionTypePriority(right.type);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return left.id - right.id;
  });
}

export function buildSupremeCourtCaseSource(
  cluster: CourtListenerCluster,
  opinions: CourtListenerOpinion[],
): SupremeCourtCaseSourceRecord {
  const sortedOpinions = sortOpinions(opinions);
  const htmlSections: string[] = [];
  const textSections: string[] = [];
  const authors = uniqueStrings([
    ...sortedOpinions.map((opinion) => opinion.author_str ?? null),
    ...parseJudges(cluster.judges),
  ]);

  sortedOpinions.forEach((opinion, index) => {
    const header = opinionHeader(opinion, index);
    const htmlBody = opinion.html_with_citations?.trim() ?? null;
    const plainBody = opinion.plain_text?.trim() ?? null;
    const textBody = htmlBody ? htmlToPlainText(htmlBody) : (plainBody ?? "");

    if (!textBody) {
      return;
    }

    textSections.push(`${header}\n\n${textBody}`);
    if (htmlBody) {
      htmlSections.push(`<section><h2>${escapeHtml(header)}</h2>${htmlBody}</section>`);
    } else {
      htmlSections.push(`<section><h2>${escapeHtml(header)}</h2><pre>${escapeHtml(textBody)}</pre></section>`);
    }
  });

  if (textSections.length === 0) {
    throw new Error(`CourtListener cluster ${cluster.id} did not contain any ingestible opinion text.`);
  }

  const citations = normalizeCitations(cluster.citations);
  const title = cluster.case_name_full?.trim() || cluster.case_name?.trim() || `Supreme Court Case ${cluster.id}`;
  const sourceUrl = cluster.absolute_url ? normalizeCourtListenerUrl(cluster.absolute_url) : null;

  return {
    externalId: buildSupremeCourtDocumentId(cluster),
    title,
    rawSource: htmlSections.join("\n"),
    rawText: textSections.join("\n\n"),
    sourceFormat: "html",
    authors,
    subjects: uniqueStrings(["supreme court", ...citations]),
    releaseDate: cluster.date_filed ?? null,
    rightsStatus: "public_domain",
    summary: citations[0] ? `Supreme Court opinion${citations.length ? ` (${citations.join("; ")})` : ""}.` : "Supreme Court opinion.",
    sourceUrl,
    metadata: {
      source: "courtlistener-api",
      upstreamProvider: "courtlistener",
      clusterId: cluster.id,
      docketNumber: cluster.docket_number ?? null,
      citations,
      judges: parseJudges(cluster.judges),
      precedentialStatus: cluster.precedential_status ?? null,
      scdbId: cluster.scdb_id ?? null,
      opinionIds: sortedOpinions.map((opinion) => opinion.id),
      opinionTypes: sortedOpinions.map((opinion) => opinion.type ?? null),
    },
  };
}

export class CourtListenerCaseLawClient {
  constructor(
    private readonly authToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = COURTLISTENER_API_BASE_URL,
  ) {}

  private async requestJson<T>(url: string): Promise<T> {
    const response = await this.fetchImpl(url, {
      headers: {
        accept: "application/json",
        authorization: `Token ${this.authToken}`,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`CourtListener request failed: ${response.status} ${await response.text()}`);
    }
    return response.json() as Promise<T>;
  }

  async countSupremeCourtClusters(startAfterId?: number | null) {
    const url = new URL(`${this.baseUrl}/clusters/`);
    url.searchParams.set("docket__court", "scotus");
    url.searchParams.set("count", "on");
    if (typeof startAfterId === "number" && Number.isFinite(startAfterId)) {
      url.searchParams.set("id__gt", String(startAfterId));
    }
    const payload = await this.requestJson<{ count?: number | string }>(url.toString());
    const rawCount = payload.count;
    return typeof rawCount === "number" ? rawCount : Number.parseInt(String(rawCount ?? "0"), 10) || 0;
  }

  async listSupremeCourtClustersPage(input: {
    nextUrl?: string | null;
    startAfterId?: number | null;
  } = {}) {
    if (input.nextUrl) {
      return this.requestJson<CourtListenerPaginatedResponse<CourtListenerCluster>>(input.nextUrl);
    }
    const url = new URL(`${this.baseUrl}/clusters/`);
    url.searchParams.set("docket__court", "scotus");
    url.searchParams.set("order_by", "id");
    url.searchParams.set(
      "fields",
      [
        "id",
        "absolute_url",
        "case_name",
        "case_name_full",
        "date_filed",
        "docket_number",
        "judges",
        "precedential_status",
        "citations",
        "scdb_id",
        "slug",
        "sub_opinions",
      ].join(","),
    );
    if (typeof input.startAfterId === "number" && Number.isFinite(input.startAfterId)) {
      url.searchParams.set("id__gt", String(input.startAfterId));
    }
    return this.requestJson<CourtListenerPaginatedResponse<CourtListenerCluster>>(url.toString());
  }

  async getCluster(clusterIdOrUrl: number | string) {
    const url = typeof clusterIdOrUrl === "number"
      ? `${this.baseUrl}/clusters/${clusterIdOrUrl}/`
      : normalizeCourtListenerUrl(clusterIdOrUrl);
    return this.requestJson<CourtListenerCluster>(url);
  }

  async getOpinion(opinionIdOrUrl: number | string) {
    const url = typeof opinionIdOrUrl === "number"
      ? `${this.baseUrl}/opinions/${opinionIdOrUrl}/`
      : normalizeCourtListenerUrl(opinionIdOrUrl);
    return this.requestJson<CourtListenerOpinion>(url);
  }

  async getClusterOpinions(cluster: CourtListenerCluster) {
    const opinionUrls = cluster.sub_opinions ?? [];
    const opinions = await Promise.all(opinionUrls.map((url) => this.getOpinion(url)));
    return opinions.filter((opinion) => Boolean(opinion));
  }
}
