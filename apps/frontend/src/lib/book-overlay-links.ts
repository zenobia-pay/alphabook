export const OPEN_BOOK_OVERLAY_LINK_EVENT = "alphabook:open-book-overlay-link";

export type ParsedBookOverlayLink = {
  workId: string;
  readerPath: string | null;
  chunkId: string | null;
  passageId: string | null;
};

export function parseBookOverlayLink(
  href: string | null | undefined,
  currentOrigin = typeof window !== "undefined" ? window.location.origin : null,
): ParsedBookOverlayLink | null {
  if (!href || !currentOrigin) {
    return null;
  }

  try {
    const url = new URL(href, currentOrigin);
    if (url.origin !== currentOrigin) {
      return null;
    }

    const workId = url.searchParams.get("work")?.trim() ?? "";
    if (!workId) {
      return null;
    }

    const view = url.searchParams.get("view")?.trim() ?? "";
    if (view && view !== "explore" && view !== "assistant" && view !== "assistant_document" && view !== "book") {
      return null;
    }

    return {
      workId,
      readerPath: url.searchParams.get("reader")?.trim() || null,
      chunkId: url.searchParams.get("chunk")?.trim() || null,
      passageId: url.hash ? decodeURIComponent(url.hash.replace(/^#/, "").trim()) || null : null,
    };
  } catch {
    return null;
  }
}
