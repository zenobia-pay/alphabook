import type { CorpusAdapter } from "@alphabook/corpus-core";

export interface CorpusAdapterRegistry {
  register(adapter: CorpusAdapter): void;
  get(adapterId: string): CorpusAdapter | null;
  getDefault(): CorpusAdapter | null;
  list(): CorpusAdapter[];
}

export function createCorpusAdapterRegistry(options?: {
  adapters?: CorpusAdapter[];
  defaultAdapterId?: string;
}): CorpusAdapterRegistry {
  const adapters = new Map<string, CorpusAdapter>();
  for (const adapter of options?.adapters ?? []) {
    adapters.set(adapter.id, adapter);
  }
  let defaultAdapterId = options?.defaultAdapterId
    ?? options?.adapters?.[0]?.id
    ?? null;

  return {
    register(adapter) {
      adapters.set(adapter.id, adapter);
      if (!defaultAdapterId) {
        defaultAdapterId = adapter.id;
      }
    },
    get(adapterId) {
      return adapters.get(adapterId) ?? null;
    },
    getDefault() {
      return defaultAdapterId ? adapters.get(defaultAdapterId) ?? null : null;
    },
    list() {
      return [...adapters.values()];
    },
  };
}
