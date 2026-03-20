import { tokenize, uniqueTokens } from "./tokenize";

const SYNONYMS: Record<string, string[]> = {
  alert: ["alarm", "notification", "page"],
  alerts: ["alarms", "notifications", "pages"],
  brittle: ["fragile", "delicate"],
  failure: ["incident", "outage", "breakdown"],
  operators: ["admins", "maintainers", "oncall"],
  trust: ["confidence", "belief"],
  theme: ["motif", "pattern"],
  maintenance: ["repair", "upkeep"],
  delayed: ["deferred", "postponed"],
  examples: ["instances", "cases"],
  compare: ["contrast"],
};

export function expandQueryTerms(query: string): string[] {
  const tokens = tokenize(query);
  const expanded = [...tokens];
  for (const token of tokens) {
    expanded.push(...(SYNONYMS[token] ?? []));
  }
  return uniqueTokens(expanded);
}
