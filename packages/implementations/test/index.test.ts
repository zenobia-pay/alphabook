import test from "node:test";
import assert from "node:assert/strict";

import {
  ALPHAJUSTICE_IMPLEMENTATION,
  buildPlannerPrompt,
  buildRouterPrompt,
  getImplementationConfig,
} from "../src/index";

test("implementation registry resolves AlphaJustice", () => {
  const config = getImplementationConfig("alphajustice");
  assert.equal(config.productName, "AlphaJustice");
  assert.equal(config.adapterId, "supreme_court");
  assert.equal(config.feedLabels.summary, "Key precedent");
  assert.equal(config.assistantWelcomeSuggestions.length > 0, true);
});

test("implementation prompt builders reflect implementation branding", () => {
  assert.match(buildPlannerPrompt(ALPHAJUSTICE_IMPLEMENTATION), /AlphaJustice/);
  assert.match(buildPlannerPrompt(ALPHAJUSTICE_IMPLEMENTATION), /United States Supreme Court cases/);
  assert.match(buildRouterPrompt(ALPHAJUSTICE_IMPLEMENTATION), /cases/);
});
