import test from "node:test";
import assert from "node:assert/strict";

import {
  ALPHABOOK_IMPLEMENTATION,
  buildPlannerPrompt,
  buildRouterPrompt,
  getImplementationConfig,
} from "../src/index";

test("implementation registry resolves AlphaBook", () => {
  const config = getImplementationConfig("alphabook");
  assert.equal(config.productName, "AlphaBook");
  assert.equal(config.adapterId, "gutenberg");
  assert.equal(config.feedLabels.summary, "Worth opening");
  assert.equal(config.assistantWelcomeSuggestions.length > 0, true);
});

test("implementation prompt builders reflect implementation branding", () => {
  assert.match(buildPlannerPrompt(ALPHABOOK_IMPLEMENTATION), /AlphaBook/);
  assert.match(buildPlannerPrompt(ALPHABOOK_IMPLEMENTATION), /75,000 books/);
  assert.match(buildRouterPrompt(ALPHABOOK_IMPLEMENTATION), /books/);
  assert.match(buildRouterPrompt(getImplementationConfig("alphabook")), /Project Gutenberg-derived library of public-domain books/);
  assert.match(buildRouterPrompt(getImplementationConfig("alphabook")), /do not answer from broad world knowledge/i);
});
