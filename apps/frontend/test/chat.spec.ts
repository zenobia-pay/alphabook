import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__alphabook_e2e_storage_reset__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__alphabook_e2e_storage_reset__", "1");
    }
  });
});

test("empty chat state renders with the ChatGPT-style layout", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("sidebar")).toBeVisible();
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await expect(page.locator(".app-shell")).toHaveScreenshot("assistant-empty.png", {
    animations: "disabled",
    caret: "hide",
    maxDiffPixelRatio: 0.02,
  });
});

test("explore centers the composer above the corpus feed", async ({ page }) => {
  await page.goto("/?view=explore");

  await expect(page.getByRole("heading", { name: "Ask or search anything" })).toBeVisible();
  await expect(page.locator(".explore-composer-root")).toBeVisible();
  await expect(page.locator(".work-feed-card")).toHaveCount(3);

  await page.locator(".work-feed-card").first().click();
  await expect(page.locator(".work-feed-card").first()).toHaveClass(/is-selected/);

  await expect(page.locator(".app-shell")).toHaveScreenshot("explore-feed.png", {
    animations: "disabled",
    caret: "hide",
    maxDiffPixelRatio: 0.02,
  });
});

test("assistant run shows retrieval, runtime, and synthesized answer in one thread", async ({ page }) => {
  await page.goto("/");

  await page.locator(".aui-composer-input").fill("Compare how Don Quixote and Moby-Dick talk about grief.");
  await page.locator(".aui-composer-send").click();

  const planMessage = page.locator(".aui-assistant-message-root").first();
  const finalMessage = page.locator(".aui-assistant-message-root").last();

  await expect(planMessage).toContainText(/Search quote/i);
  await expect(planMessage).toContainText(/Find passages/i);
  await expect(planMessage).toContainText(/Deep search/i);
  await expect(finalMessage).toContainText(/Workspace Summary/i);
  await expect(finalMessage).toContainText(/Don Quixote/i);
  await expect(finalMessage).toContainText(/Moby-Dick/i);
  await expect(page.getByTestId("empty-state")).toHaveCount(0);

  await expect(page.locator(".app-shell")).toHaveScreenshot("assistant-thread.png", {
    animations: "disabled",
    caret: "hide",
    maxDiffPixelRatio: 0.02,
  });
});

test("sidebar history can reopen an earlier conversation", async ({ page }) => {
  await page.goto("/");

  await page.locator(".aui-composer-input").fill("Find books about sadness.");
  await page.locator(".aui-composer-send").click();
  await expect(page.locator(".aui-assistant-message-root").last()).toContainText(/I started with the indexed corpus/i);

  await page.getByRole("button", { name: "Assistant" }).click();
  await page.locator(".aui-composer-input").fill("Compare ambition across Middlemarch and Don Quixote.");
  await page.locator(".aui-composer-send").click();
  await expect(page.getByText(/I then ran a deeper workspace search/i)).toBeVisible();

  await page.getByRole("button", { name: "Library" }).click();
  await page.getByRole("button", { name: /Find books about sadness/i }).click();
  await expect(page.locator(".aui-user-message-root").last()).toContainText("Find books about sadness.");

  await expect(page.locator(".app-shell")).toHaveScreenshot("assistant-history.png", {
    animations: "disabled",
    caret: "hide",
    maxDiffPixelRatio: 0.02,
  });
});

test("current view and assistant session persist in the URL across refresh", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Explore" }).click();
  await expect(page).toHaveURL(/view=explore/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Ask or search anything" })).toBeVisible();

  await page.getByRole("button", { name: "Assistant" }).click();
  await page.locator(".aui-composer-input").fill("Find books about sadness.");
  await page.locator(".aui-composer-send").click();

  await expect(page).toHaveURL(/view=assistant/);
  await expect(page).toHaveURL(/session=/);
  await expect(page.locator(".aui-user-message-root").last()).toContainText("Find books about sadness.");

  await page.reload();
  await expect(page.locator(".aui-user-message-root").last()).toContainText("Find books about sadness.");
  await expect(page.locator(".aui-assistant-message-root").last()).toContainText(/Workspace Summary/i);
});

test("logged out assistant keeps the normal shell while disabling the composer", async ({ page }) => {
  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authConfigured: true,
        authenticated: false,
        user: null,
        auth: null,
      }),
    });
  });

  await page.route("**/api/admin/access", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        allowed: false,
        authenticated: false,
        authConfigured: true,
        user: null,
      }),
    });
  });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Search for evidence and themes over 75,000 books." })).toBeVisible();
  await expect(page.locator(".aui-composer-input")).toBeDisabled();
  const thread = page.getByTestId("thread");
  await expect(thread.getByText("Sign in to start a research thread.")).toBeVisible();
  await expect(thread.getByRole("link", { name: "Sign in" })).toBeVisible();
});

test("browser back moves through prior views", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Explore" }).click();
  await expect(page.getByRole("heading", { name: "Ask or search anything" })).toBeVisible();

  await page.locator(".work-feed-card").first().click();
  await expect(page).toHaveURL(/\/works\//);
  await expect(page.locator(".book-page")).toBeVisible();

  await page.goBack();
  await expect(page.getByRole("heading", { name: "Ask or search anything" })).toBeVisible();
  await expect(page).toHaveURL(/view=explore/);

  await page.goBack();
  await expect(page.locator(".aui-composer-input")).toBeVisible();
  await expect(page).toHaveURL(/view=assistant/);
});

test.describe("mobile shell", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("navigation collapses into a hamburger drawer", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByLabel("Open navigation")).toBeVisible();
    await page.getByLabel("Open navigation").click();
    await expect(page.getByTestId("sidebar")).toHaveClass(/is-open/);

    await expect(page.locator(".app-shell")).toHaveScreenshot("assistant-mobile-drawer.png", {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.02,
    });

    await page.getByLabel("Close menu").click();
    await expect(page.getByTestId("sidebar")).not.toHaveClass(/is-open/);
  });

  test("explore header and composer stay clear of the mobile shell", async ({ page }) => {
    await page.goto("/?view=explore");

    const shellBar = page.locator(".mobile-shell-bar");
    const heroHeading = page.locator(".explore-hero h1");
    const composer = page.locator(".explore-composer-root");

    await expect(shellBar).toBeVisible();
    await expect(heroHeading).toBeVisible();
    await expect(composer).toBeVisible();

    const shellBarBox = await shellBar.boundingBox();
    const heroHeadingBox = await heroHeading.boundingBox();
    const composerBox = await composer.boundingBox();

    expect(shellBarBox).not.toBeNull();
    expect(heroHeadingBox).not.toBeNull();
    expect(composerBox).not.toBeNull();

    expect(heroHeadingBox!.y).toBeGreaterThanOrEqual(shellBarBox!.y + shellBarBox!.height - 1);
    expect(composerBox!.y).toBeGreaterThan(heroHeadingBox!.y);
    expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  });
});
