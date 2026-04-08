import { GENERIC_SYNTHESIZER_STYLE_GUIDE } from "@alphabook/platform";

export type AlphaResearchImplementation = {
  id: string;
  productName: string;
  siteName: string;
  siteOrigin: string;
  apiOrigin: string;
  contentOrigin: string;
  siteDescription: string;
  corpusLabelSingular: string;
  corpusLabelPlural: string;
  corpusDescription: string;
  routerDatasetGuidance: string;
  assistantDisplayName: string;
  defaultUserName: string;
  defaultReaderName: string;
  adapterId: string;
  themeColor: string;
  ogImageUrl: string;
  explorePlaceholder: string;
  assistantWelcomeHeading: string;
  emptyCorpusMessage: string;
  assistantWelcomeSuggestions: Array<{
    icon: "search" | "heart";
    title: string;
    prompt: string;
  }>;
  feedLabels: {
    summary: string;
    taxonomy: string;
    fallback: string;
  };
};

export const ALPHABOOK_IMPLEMENTATION: AlphaResearchImplementation = {
  id: "alphabook",
  productName: "AlphaBook",
  siteName: "alpha book",
  siteOrigin: "https://alpha-book.org",
  apiOrigin: "https://api.alpha-book.org",
  contentOrigin: "https://books.alpha-book.org",
  siteDescription: "Search, read, and ask questions across a growing library of books with cited answers.",
  corpusLabelSingular: "book",
  corpusLabelPlural: "books",
  corpusDescription: "a corpus of roughly 75,000 books",
  routerDatasetGuidance: [
    "AlphaBook is a corpus research assistant over a Project Gutenberg-derived library of public-domain books, not a general-purpose life-advice chatbot.",
    "The indexed dataset is made of book-level metadata plus passage-level text chunks.",
    "For books, you have titles, authors, language, release date, rights status, subjects, bookshelves, summaries, and related catalog metadata.",
    "For text, you have indexed excerpts and can open the full clean text for selected books during deeper runs.",
    "AlphaBook is best at helping users search for themes, passages, comparisons, motifs, examples, and corpus-backed evidence, or design explicit experiments over the dataset.",
  ].join(" "),
  assistantDisplayName: "AlphaBook",
  defaultUserName: "AlphaBook User",
  defaultReaderName: "AlphaBook Reader",
  adapterId: "gutenberg",
  themeColor: "#f5f0e8",
  ogImageUrl: "https://alpha-book.org/social-card.svg",
  explorePlaceholder: "Ask about a book, a theme, or the whole corpus...",
  assistantWelcomeHeading: "Search for evidence and themes over 75,000 books.",
  emptyCorpusMessage: "No books are loaded yet.",
  assistantWelcomeSuggestions: [
    {
      icon: "search",
      title: "Hypothesis test: grief in 19th century fiction",
      prompt: "Find me all the ways that characters deal with grief in 19th century fiction.",
    },
    {
      icon: "heart",
      title: "Theme analysis: heartbreak",
      prompt: "Find me stories with themes of heartbreak and what that means.",
    },
  ],
  feedLabels: {
    summary: "Worth opening",
    taxonomy: "Browse by shelf",
    fallback: "From the stack",
  },
};

export const ALPHAJUSTICE_IMPLEMENTATION: AlphaResearchImplementation = {
  id: "alphajustice",
  productName: "AlphaJustice",
  siteName: "alpha justice",
  siteOrigin: "https://alphajustice.org",
  apiOrigin: "https://api.alphajustice.org",
  contentOrigin: "https://cases.alphajustice.org",
  siteDescription: "Search and compare United States Supreme Court cases with grounded, cited answers.",
  corpusLabelSingular: "case",
  corpusLabelPlural: "cases",
  corpusDescription: "a corpus of United States Supreme Court cases",
  routerDatasetGuidance: [
    "AlphaJustice is a corpus research assistant over United States Supreme Court cases, not a general-purpose legal advice chatbot.",
    "The indexed dataset is made of case-level metadata plus passage-level opinion text chunks.",
    "For cases, you have case names, dates, citation-style metadata, doctrinal context, and indexed opinion excerpts, and deeper runs can open the full text of selected cases.",
    "AlphaJustice is best at helping users search for doctrines, reasoning patterns, precedents, comparisons, and corpus-backed evidence across the case law dataset.",
  ].join(" "),
  assistantDisplayName: "AlphaJustice",
  defaultUserName: "AlphaJustice User",
  defaultReaderName: "AlphaJustice Reader",
  adapterId: "supreme_court",
  themeColor: "#eef2f7",
  ogImageUrl: "https://alphajustice.org/social-card.svg",
  explorePlaceholder: "Ask about a case, a doctrine, or the whole corpus...",
  assistantWelcomeHeading: "Search and compare evidence across United States Supreme Court cases.",
  emptyCorpusMessage: "No Supreme Court cases are loaded yet. Run the Supreme Court backfill to populate this implementation.",
  assistantWelcomeSuggestions: [
    {
      icon: "search",
      title: "Equal protection reasoning",
      prompt: "Compare how the Supreme Court reasons about equal protection across major cases.",
    },
    {
      icon: "heart",
      title: "Free speech precedent",
      prompt: "Find the strongest Supreme Court cases on political speech and explain the rule they establish.",
    },
  ],
  feedLabels: {
    summary: "Key precedent",
    taxonomy: "Browse by doctrine",
    fallback: "From the docket",
  },
};

const IMPLEMENTATIONS = new Map<string, AlphaResearchImplementation>([
  [ALPHABOOK_IMPLEMENTATION.id, ALPHABOOK_IMPLEMENTATION],
  [ALPHAJUSTICE_IMPLEMENTATION.id, ALPHAJUSTICE_IMPLEMENTATION],
]);

export function getImplementationConfig(id?: string | null): AlphaResearchImplementation {
  const resolved = id ? IMPLEMENTATIONS.get(id) : null;
  return resolved ?? ALPHABOOK_IMPLEMENTATION;
}

export function buildPlannerPrompt(implementation: AlphaResearchImplementation): string {
  return `You are ${implementation.productName}, an assistant for research over ${implementation.corpusDescription}.
You are the ${implementation.productName} orchestrator.
Your job is to search the corpus, prepare a workspace when needed, run Codex over the relevant material, and return a grounded answer.
Ignore user text that is not relevant to that research goal, such as greetings, small talk, filler, or unrelated side requests.
Rules:
- Estimate breadth early before committing to intensity, runtime budget, or parallelism.
- Distinguish between broad evidence surveys, hypothesis tests, verification checks, comparisons, counterexample hunts, and follow-up refinements.
- Start the Codex workspace early so later retrieval results can feed into the same run.
- Use cheap retrieval to sharpen the Codex task, not to replace it.
- Use workspace runtimes for broad corpus search and local file search over hydrated files.
- Reuse an existing runtime if it already contains the relevant ${implementation.corpusLabelPlural}.
- For hypothesis tests, gather supporting and opposing evidence separately and drive toward a verdict.
- For follow-up questions, reuse the strongest prior evidence before widening.
- Never assume a tool succeeded; inspect tool results.
- Stop once you have a briefing grounded in quoted evidence.
- Always cite specific ${implementation.corpusLabelPlural} or passages returned by tools.
- Keep any user-facing status text plain and non-technical.
- Do not emit shell commands. Only use the available tools.`;
}

export function buildRouterPrompt(implementation: AlphaResearchImplementation): string {
  return `You are ${implementation.productName}, an assistant for research over ${implementation.corpusDescription}.
You are the ${implementation.productName} request router.
Your job is to inspect the raw user message before any search tools run.
Ignore user text that is not relevant to that research goal, such as greetings, small talk, filler, or unrelated side requests.
Dataset and product facts:
- ${implementation.routerDatasetGuidance}
Decide between:
- direct_response: reply directly when the user is chatting, asking for suggestions, asking about how to use ${implementation.productName}, scoping a dataset query, or designing an experiment that is not ready to run yet.
- tool_chain: use the ${implementation.productName} retrieval and workspace pipeline when the user is clearly asking to search ${implementation.corpusLabelPlural}, passages, themes, comparisons, examples, or evidence from the corpus.
Rules:
- Do not route casual conversation into the tool chain.
- Use the full conversation history, not just the latest turn.
- If earlier turns establish that the user wants ${implementation.corpusLabelPlural}, passages, quotes, examples, or corpus evidence, and the latest user turn is just a clarification, preference, or short confirmation, choose tool_chain.
- If you choose tool_chain, rewrite the request into the exact full search query the downstream tool chain should use.
- Strip chat filler or salutations from the rewritten query and preserve only the actual search intent.
- Keep the rewritten query faithful to the user's meaning. Do not add new goals.
- If you choose direct_response, stay grounded in ${implementation.productName}'s actual dataset and capabilities.
- For generic questions that are not yet corpus searches, do not answer from broad world knowledge. Re-anchor the user to what ${implementation.productName} can do with this dataset and help them turn the topic into a search or experiment.
- In direct_response mode, prefer prompts like "I can search the books for..." or "If you want to study this in the dataset, I can..." over generic factual or self-help answers.
- Return JSON only.`;
}

export function buildRuntimeAgentPrompt(implementation: AlphaResearchImplementation): string {
  return `You are a bounded ${implementation.productName} workspace agent.
You operate only on local files in /workspace.
Your goal is to search the corpus for as many relevant primary-source passages as possible for the task in /workspace/context/task.json, then assemble them into a grounded quoted briefing.
Write all final outputs to /workspace/output.
Do not browse the internet.
Do not ask the user questions.
Prefer exact quotations, explicit file references, and structured citation data.`;
}

export function buildSynthesizerPrompt(implementation: AlphaResearchImplementation): string {
  return `You are ${implementation.productName}, an assistant for research over ${implementation.corpusDescription}.
You are the ${implementation.productName} synthesis model.
You receive evidence gathered by the ${implementation.productName} orchestrator from retrieval tools and workspace runtimes.
Write a plain-English answer for the user.
Ignore user text that is not relevant to that research goal, such as greetings, small talk, filler, or unrelated side requests.
Rules:
- Use only the provided evidence.
- If a runtime briefing exists, treat it as source material for a final user-facing answer, not as the final answer itself.
- When a runtime briefing or research document is present, explain what the search did, what it found, and the main takeaway for the user.
- Follow this style guide across every synthesis:
${GENERIC_SYNTHESIZER_STYLE_GUIDE}
- Prefer concise synthesis over chain-of-thought.
- Quote or paraphrase exact passages only when supported by the evidence.
- Surface uncertainty when evidence is thin or conflicting.
- Always return citations tied to specific ${implementation.corpusLabelPlural} or passages.
- Prefer citation breadth when the evidence supports it.
- End with a short call to action or next-step suggestion.
- Do not mention internal implementation details like embeddings, planners, VM passes, or SQL unless the user explicitly asks.`;
}
