import type { BenchmarkCorpus, QuerySet } from "./types";

export const fixtureBenchmarkCorpus: BenchmarkCorpus = {
  id: "fixture-associative",
  displayName: "Fixture Associative Corpus",
  description: "A small corpus for exercising lexical, paraphrase, associative, and metadata-constrained retrieval.",
  documents: [
    {
      id: "ops-memo",
      title: "Operations Memo on Alarm Fatigue",
      summary: "Notes on how false alarms changed operator behavior.",
      language: "en",
      rightsStatus: "internal",
      contributors: ["Ops Team"],
      metadata: {
        year: 2023,
        sourceType: "memo",
        tags: ["alerts", "operations"],
      },
    },
    {
      id: "maintenance-journal",
      title: "Maintenance Journal",
      summary: "A log of deferred upkeep that later caused incidents.",
      language: "en",
      rightsStatus: "internal",
      contributors: ["Platform Group"],
      metadata: {
        year: 2021,
        sourceType: "journal",
        tags: ["maintenance", "reliability"],
      },
    },
    {
      id: "field-guide",
      title: "Field Guide to Resilient Teams",
      summary: "A guide to team routines during incidents.",
      language: "en",
      rightsStatus: "internal",
      contributors: ["Reliability Group"],
      metadata: {
        year: 2024,
        sourceType: "guide",
        tags: ["teams", "reliability"],
      },
    },
  ],
  passages: [
    {
      id: "ops-memo-p1",
      documentId: "ops-memo",
      chunkIndex: 0,
      text: "Repeated false alarms trained operators to ignore the paging system. When the real outage arrived, the team had already lost confidence in the alert stream.",
      excerpt: "Repeated false alarms trained operators to ignore the paging system.",
      metadata: { year: 2023, tags: ["alerts", "confidence"] },
    },
    {
      id: "ops-memo-p2",
      documentId: "ops-memo",
      chunkIndex: 1,
      text: "The memo recommends reducing noisy notifications before adding new checks because brittle warning channels collapse under distrust.",
      excerpt: "The memo recommends reducing noisy notifications before adding new checks.",
      metadata: { year: 2023, tags: ["notifications", "noise"] },
    },
    {
      id: "maintenance-journal-p1",
      documentId: "maintenance-journal",
      chunkIndex: 0,
      text: "Maintenance was postponed quarter after quarter because the service still appeared stable. The eventual outage forced an emergency repair window that was longer and more expensive.",
      excerpt: "Maintenance was postponed quarter after quarter because the service still appeared stable.",
      metadata: { year: 2021, tags: ["maintenance", "outage"] },
    },
    {
      id: "maintenance-journal-p2",
      documentId: "maintenance-journal",
      chunkIndex: 1,
      text: "The journal compares preventive upkeep with reactive repairs and concludes that deferred work turns routine fixes into incidents.",
      excerpt: "Deferred work turns routine fixes into incidents.",
      metadata: { year: 2021, tags: ["upkeep", "incident"] },
    },
    {
      id: "field-guide-p1",
      documentId: "field-guide",
      chunkIndex: 0,
      text: "Resilient teams practice shared incident review, compare examples across previous failures, and document recurring patterns before they harden into folklore.",
      excerpt: "Resilient teams compare examples across previous failures and document recurring patterns.",
      metadata: { year: 2024, tags: ["patterns", "comparison"] },
    },
    {
      id: "field-guide-p2",
      documentId: "field-guide",
      chunkIndex: 1,
      text: "A constraint-heavy search often needs filters such as year, team, or source type before the right evidence becomes visible.",
      excerpt: "A constraint-heavy search often needs filters such as year, team, or source type.",
      metadata: { year: 2024, tags: ["filters", "metadata"], sourceType: "guide" },
    },
  ],
};

export const fixtureQuerySet: QuerySet = {
  id: "fixture-v1",
  version: "1.0.0",
  description: "A minimal query set covering each benchmark family.",
  queries: [
    {
      id: "q-lexical",
      text: "Which passage says maintenance was postponed quarter after quarter?",
      family: "lexical-easy",
      labels: [{ passageId: "maintenance-journal-p1", grade: 2 }],
    },
    {
      id: "q-paraphrase",
      text: "Where do reactive repairs replace preventive upkeep?",
      family: "paraphrase",
      labels: [{ passageId: "maintenance-journal-p2", grade: 2 }],
    },
    {
      id: "q-associative",
      text: "Find evidence that teams stopped trusting alerts because warning systems became noisy.",
      family: "associative",
      labels: [
        { passageId: "ops-memo-p1", grade: 2 },
        { passageId: "ops-memo-p2", grade: 1 },
      ],
    },
    {
      id: "q-multihop",
      text: "Compare examples of recurring failure patterns across incidents.",
      family: "multi-hop-thematic",
      labels: [{ passageId: "field-guide-p1", grade: 2 }],
    },
    {
      id: "q-constraint",
      text: "Find the guide passage about filters for narrowing a search.",
      family: "constraint-heavy",
      filters: { sourceType: "guide", year: 2024 },
      labels: [{ passageId: "field-guide-p2", grade: 2 }],
    },
  ],
};
