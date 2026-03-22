import { createCorpusAdapterRegistry } from "@alphabook/platform";
import { gutenbergCorpusAdapter } from "@alphabook/source-gutenberg/adapter";

const adapterRegistry = createCorpusAdapterRegistry({
  adapters: [gutenbergCorpusAdapter],
  defaultAdapterId: gutenbergCorpusAdapter.id,
});

const resolvedDefaultCorpusAdapter = adapterRegistry.getDefault();

if (!resolvedDefaultCorpusAdapter) {
  throw new Error("Default corpus adapter is not configured.");
}

export function getCorpusAdapter(adapterId?: string) {
  return adapterId ? adapterRegistry.get(adapterId) : adapterRegistry.getDefault();
}

export function getCorpusAdapterRegistry() {
  return adapterRegistry;
}

export const defaultCorpusAdapter = resolvedDefaultCorpusAdapter;
