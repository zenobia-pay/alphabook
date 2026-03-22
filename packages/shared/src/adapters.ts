import { createCorpusAdapterRegistry } from "@alphabook/platform";
import { gutenbergCorpusAdapter } from "@alphabook/source-gutenberg/adapter";
import { supremeCourtCorpusAdapter } from "@alphabook/source-supreme-court/adapter";

const adapterRegistry = createCorpusAdapterRegistry({
  adapters: [gutenbergCorpusAdapter, supremeCourtCorpusAdapter],
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
