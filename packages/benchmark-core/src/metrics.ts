import type { BenchmarkLabel, RetrievalHit } from "./types";

function gain(grade: number): number {
  return (2 ** grade) - 1;
}

function buildGradeMap(labels: BenchmarkLabel[]): Map<string, number> {
  return new Map(labels.map((label) => [label.passageId, label.grade]));
}

export function recallAtK(labels: BenchmarkLabel[], hits: RetrievalHit[], k: number): number {
  if (labels.length === 0) {
    return 0;
  }
  const relevant = new Set(labels.filter((label) => label.grade > 0).map((label) => label.passageId));
  if (relevant.size === 0) {
    return 0;
  }
  const matched = hits.slice(0, k).filter((hit) => relevant.has(hit.passageId));
  return matched.length / relevant.size;
}

export function successAtK(labels: BenchmarkLabel[], hits: RetrievalHit[], k: number): number {
  const highlyRelevant = new Set(labels.filter((label) => label.grade >= 2).map((label) => label.passageId));
  if (highlyRelevant.size === 0) {
    return 0;
  }
  return hits.slice(0, k).some((hit) => highlyRelevant.has(hit.passageId)) ? 1 : 0;
}

export function ndcgAtK(labels: BenchmarkLabel[], hits: RetrievalHit[], k: number): number {
  const gradeMap = buildGradeMap(labels);
  const dcg = hits.slice(0, k).reduce((total, hit, index) => {
    const grade = gradeMap.get(hit.passageId) ?? 0;
    if (grade <= 0) {
      return total;
    }
    return total + (gain(grade) / Math.log2(index + 2));
  }, 0);

  const idealGrades = labels
    .map((label) => label.grade)
    .filter((grade) => grade > 0)
    .sort((left, right) => right - left)
    .slice(0, k);

  const idcg = idealGrades.reduce<number>((total, grade, index) => {
    return total + (gain(grade) / Math.log2(index + 2));
  }, 0);

  return idcg === 0 ? 0 : dcg / idcg;
}

export function computeMetrics(labels: BenchmarkLabel[], hits: RetrievalHit[]): Record<string, number> {
  return {
    recallAt20: recallAtK(labels, hits, 20),
    recallAt100: recallAtK(labels, hits, 100),
    ndcgAt20: ndcgAtK(labels, hits, 20),
    successAt20: successAtK(labels, hits, 20),
  };
}

export function averageMetric(records: Array<Record<string, number>>): Record<string, number> {
  if (records.length === 0) {
    return {};
  }
  const totals = new Map<string, number>();
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      totals.set(key, (totals.get(key) ?? 0) + value);
    }
  }
  return Object.fromEntries(
    Array.from(totals.entries()).map(([key, value]) => [key, value / records.length]),
  );
}
