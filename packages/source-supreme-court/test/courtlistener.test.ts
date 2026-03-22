import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSupremeCourtCaseSource,
  htmlToPlainText,
  type CourtListenerCluster,
  type CourtListenerOpinion,
} from "../src/courtlistener";

test("htmlToPlainText strips tags and preserves basic spacing", () => {
  const text = htmlToPlainText("<p>Hello <em>world</em>.</p><p>Second&nbsp;paragraph.</p>");
  assert.equal(text, "Hello world.\n\nSecond paragraph.");
});

test("buildSupremeCourtCaseSource combines opinion texts into a single case document", () => {
  const cluster: CourtListenerCluster = {
    id: 2812209,
    absolute_url: "/opinion/2812209/obergefell-v-hodges/",
    case_name: "Obergefell v. Hodges",
    case_name_full: "Obergefell v. Hodges",
    date_filed: "2015-06-26",
    docket_number: "14-556",
    judges: "Anthony M. Kennedy, John G. Roberts Jr.",
    citations: [{ cite: "576 U.S. 644", type: "official" }],
    precedential_status: "Published",
    scdb_id: "2014-061",
    sub_opinions: [
      "https://www.courtlistener.com/api/rest/v3/opinions/1/",
      "https://www.courtlistener.com/api/rest/v3/opinions/2/",
    ],
  };

  const opinions: CourtListenerOpinion[] = [
    {
      id: 2,
      type: "050dissent",
      author_str: "John G. Roberts Jr.",
      plain_text: "The Constitution had nothing to do with it.",
    },
    {
      id: 1,
      type: "010combined",
      author_str: "Anthony M. Kennedy",
      html_with_citations: "<p>The right to marry is fundamental.</p>",
    },
  ];

  const source = buildSupremeCourtCaseSource(cluster, opinions);

  assert.equal(source.externalId, "courtlistener-cluster-2812209");
  assert.equal(source.title, "Obergefell v. Hodges");
  assert.equal(source.sourceFormat, "html");
  assert.equal(source.releaseDate, "2015-06-26");
  assert.deepEqual(source.authors, ["Anthony M. Kennedy", "John G. Roberts Jr."]);
  assert.match(source.rawText, /Opinion 1 - combined - Anthony M. Kennedy/i);
  assert.match(source.rawText, /right to marry is fundamental/i);
  assert.match(source.rawText, /Opinion 2 - dissent - John G. Roberts Jr./i);
  assert.equal(source.metadata.clusterId, 2812209);
  assert.deepEqual(source.metadata.citations, ["576 U.S. 644"]);
  assert.equal(source.sourceUrl, "https://www.courtlistener.com/opinion/2812209/obergefell-v-hodges/");
});
