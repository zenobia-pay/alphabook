#!/usr/bin/env node

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const HOST = process.env.OPENAI_LOG_PROXY_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.OPENAI_LOG_PROXY_PORT || "8790", 10);
const LOG_ROOT = process.env.OPENAI_LOG_PROXY_LOG_ROOT || "/srv/alphabook/logs/openai-proxy";
const UPSTREAM_BASE_URL = process.env.OPENAI_LOG_PROXY_UPSTREAM_BASE_URL || "https://api.openai.com";
const UPSTREAM_API_KEY = process.env.OPENAI_LOG_PROXY_UPSTREAM_API_KEY || process.env.OPENAI_API_KEY || "";

const MODEL_PRICING = {
  "gpt-5.4": { inputPerMillion: 2.5, outputPerMillion: 15.0 },
  "gpt-5": { inputPerMillion: 2.5, outputPerMillion: 15.0 },
  "gpt-5.4-mini": { inputPerMillion: 0.75, outputPerMillion: 4.5 },
  "gpt-5.4-nano": { inputPerMillion: 0.2, outputPerMillion: 1.25 },
  "gpt-5-mini": { inputPerMillion: 0.25, outputPerMillion: 2.0 },
  "gpt-5-nano": { inputPerMillion: 0.05, outputPerMillion: 0.4 },
};

await fsp.mkdir(LOG_ROOT, { recursive: true });

function nowIso() {
  return new Date().toISOString();
}

function buildRequestId() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
}

function pricingFor(model) {
  return MODEL_PRICING[model] || MODEL_PRICING["gpt-5.4"];
}

function estimateCost(model, usage) {
  if (!usage) {
    return null;
  }
  const pricing = pricingFor(model);
  const promptTokens = Number(usage.prompt_tokens || 0);
  const completionTokens = Number(usage.completion_tokens || 0);
  return Number((((promptTokens / 1_000_000) * pricing.inputPerMillion) + ((completionTokens / 1_000_000) * pricing.outputPerMillion)).toFixed(6));
}

function jsonOrText(buffer) {
  const text = buffer.toString("utf8");
  try {
    return { kind: "json", parsed: JSON.parse(text), text };
  } catch {
    return { kind: "text", parsed: null, text };
  }
}

function sanitizedHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = key.toLowerCase() === "authorization" ? "[redacted]" : value;
  }
  return result;
}

function usageFromStreamBody(text) {
  let usage = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) {
      continue;
    }
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }
    try {
      const parsed = JSON.parse(payload);
      if (parsed?.usage) {
        usage = parsed.usage;
      }
    } catch {
      continue;
    }
  }
  return usage;
}

async function writeJson(filePath, value) {
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function appendIndex(record) {
  await fsp.appendFile(path.join(LOG_ROOT, "requests.jsonl"), `${JSON.stringify(record)}\n`);
}

const server = http.createServer(async (req, res) => {
  const requestId = buildRequestId();
  const startedAt = nowIso();
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const requestBodyBuffer = Buffer.concat(chunks);
  const requestBody = jsonOrText(requestBodyBuffer);
  const requestPayload = requestBody.parsed;

  const upstreamUrl = new URL(req.url || "/", UPSTREAM_BASE_URL);
  const requestFile = path.join(LOG_ROOT, `${requestId}.request.json`);
  const responseFile = path.join(LOG_ROOT, `${requestId}.response.json`);

  const method = req.method || "GET";
  const model = requestPayload?.model || null;

  const requestRecord = {
    requestId,
    startedAt,
    method,
    path: req.url || "/",
    upstreamUrl: upstreamUrl.toString(),
    requestHeaders: sanitizedHeaders(req.headers),
    requestBody: requestBody.kind === "json" ? requestPayload : requestBody.text,
  };
  await writeJson(requestFile, requestRecord);

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method,
      headers: {
        ...Object.fromEntries(Object.entries(req.headers).filter(([key]) => key.toLowerCase() !== "host" && key.toLowerCase() !== "content-length" && key.toLowerCase() !== "authorization")),
        authorization: `Bearer ${UPSTREAM_API_KEY}`,
      },
      body: requestBodyBuffer.length > 0 ? requestBodyBuffer : undefined,
      duplex: "half",
    });

    const responseBuffer = Buffer.from(await upstreamResponse.arrayBuffer());
    const responseBody = jsonOrText(responseBuffer);
    const usage = responseBody.parsed?.usage || (responseBody.kind === "text" ? usageFromStreamBody(responseBody.text) : null);
    const estimatedCostUsd = estimateCost(model || responseBody.parsed?.model || "", usage);

    const responseRecord = {
      requestId,
      finishedAt: nowIso(),
      status: upstreamResponse.status,
      ok: upstreamResponse.ok,
      responseHeaders: sanitizedHeaders(Object.fromEntries(upstreamResponse.headers.entries())),
      responseBody: responseBody.kind === "json" ? responseBody.parsed : responseBody.text,
      usage,
      estimatedCostUsd,
    };
    await writeJson(responseFile, responseRecord);
    await appendIndex({
      requestId,
      startedAt,
      finishedAt: responseRecord.finishedAt,
      method,
      path: req.url || "/",
      model: model || responseBody.parsed?.model || null,
      status: upstreamResponse.status,
      usage,
      estimatedCostUsd,
      requestFile,
      responseFile,
    });

    res.writeHead(upstreamResponse.status, Object.fromEntries(upstreamResponse.headers.entries()));
    res.end(responseBuffer);
  } catch (error) {
    const failure = {
      requestId,
      finishedAt: nowIso(),
      error: error instanceof Error ? error.stack || error.message : String(error),
    };
    await writeJson(responseFile, failure);
    await appendIndex({
      requestId,
      startedAt,
      finishedAt: failure.finishedAt,
      method,
      path: req.url || "/",
      model,
      status: 599,
      usage: null,
      estimatedCostUsd: null,
      requestFile,
      responseFile,
      error: failure.error,
    });
    res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    res.end(`${JSON.stringify({ error: "upstream_proxy_error", requestId }, null, 2)}\n`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`OpenAI logging proxy listening on http://${HOST}:${PORT} -> ${UPSTREAM_BASE_URL}`);
});
