import type {
  DocumentDetail,
  DocumentSource,
  DocumentSummary,
  PlatformCitation,
} from "@alphabook/platform";
import {
  citationToPlatformCitation,
  documentSourceToWorkSource,
  documentSummaryToWorkSummary,
  platformCitationToLegacyCitation,
  workDetailToDocumentDetail,
  workSourceToDocumentSource,
  workSummaryToDocumentSummary,
} from "@alphabook/platform";

import type { Citation, WorkDetail, WorkSource, WorkSummary } from "./types";

export function toDocumentSummary(work: WorkSummary): DocumentSummary {
  return workSummaryToDocumentSummary(work);
}

export function toDocumentDetail(work: WorkDetail): DocumentDetail {
  return workDetailToDocumentDetail(work);
}

export function toWorkSummary(document: DocumentSummary): WorkSummary {
  return documentSummaryToWorkSummary(document) as WorkSummary;
}

export function toWorkSource(documentSource: DocumentSource): WorkSource {
  return documentSourceToWorkSource(documentSource) as WorkSource;
}

export function toDocumentSource(workSource: WorkSource): DocumentSource {
  return workSourceToDocumentSource(workSource);
}

export function toPlatformCitationCompat(citation: Citation): PlatformCitation {
  return citationToPlatformCitation(citation);
}

export function toLegacyCitation(citation: PlatformCitation): Citation {
  return platformCitationToLegacyCitation(citation) as Citation;
}
