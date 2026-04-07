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
  await page.goto("/?view=explore");

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

test("failed works bootstrap does not retry in a loop and only retries on demand", async ({ page }) => {
  let worksHits = 0;

  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authConfigured: false,
        authenticated: false,
        user: null,
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
        authConfigured: false,
        user: null,
      }),
    });
  });

  await page.route("**/api/works?offset=0&limit=12", async (route) => {
    worksHits += 1;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: "forced failure",
      }),
    });
  });

  await page.goto("/?view=explore");

  await expect(page.getByText("We couldn't load the corpus feed.")).toBeVisible();
  await page.waitForTimeout(1200);
  expect(worksHits).toBe(1);

  await page.getByRole("button", { name: "Retry" }).click();
  await page.waitForTimeout(200);
  expect(worksHits).toBe(2);
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
  await expect(page.locator(".aui-assistant-message-root").last()).toContainText(/Workspace Summary|indexed corpus/i);

  await page.getByRole("button", { name: "New chat" }).click();
  await page.locator(".aui-composer-input").fill("Compare ambition across Middlemarch and Don Quixote.");
  await page.locator(".aui-composer-send").click();
  await expect(page.locator(".aui-assistant-message-root").last()).toContainText(/Workspace Summary|deeper workspace search/i);

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

  await page.getByRole("button", { name: "New chat" }).click();
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

test("new chat renders immediately instead of showing a loading skeleton during auth", async ({ page }) => {
  await page.route("**/api/me", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authConfigured: false,
        authenticated: false,
        user: null,
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
        authConfigured: false,
        user: null,
      }),
    });
  });

  await page.goto("/?view=assistant", { waitUntil: "domcontentloaded" });

  await expect(page.getByTestId("empty-state")).toBeVisible();
  await expect(page.locator(".assistant-workspace-loading")).toHaveCount(0);
  await expect(page.locator(".assistant-workspace-page")).toHaveCount(0);
});

test("session route keeps the real assistant composer visible while conversation data is loading", async ({ page }) => {
  const sessionId = "11111111-1111-4111-8111-111111111113";

  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authConfigured: true,
        authenticated: true,
        user: {
          id: "local-user",
          email: "local@example.com",
          name: "Local User",
        },
      }),
    });
  });

  await page.route("**/api/admin/access", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        allowed: false,
        authenticated: true,
        authConfigured: true,
        user: {
          id: "local-user",
          email: "local@example.com",
          name: "Local User",
        },
      }),
    });
  });

  await page.route(/\/api\/sessions(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          {
            id: sessionId,
            userId: "local-user",
            title: "Delayed thread",
            createdAt: "2026-03-16T12:00:00.000Z",
            lastMessageAt: "2026-03-16T12:00:00.000Z",
            lastMessagePreview: "Delayed thread",
          },
        ],
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/messages`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        messages: [],
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/runs`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runs: [],
      }),
    });
  });

  await page.goto(`/?view=assistant&session=${sessionId}`, { waitUntil: "domcontentloaded" });

  await expect(page.locator(".assistant-workspace-loading")).toHaveCount(0);
  await expect(page.locator(".assistant-document-entry.is-title")).toHaveCount(0);
  await expect(page.locator(".assistant-document-body")).toHaveCount(0);
  await expect(page.locator(".aui-composer-input")).toBeVisible();
  await expect(page.getByTestId("assistant-workspace-thread")).toBeVisible({ timeout: 5000 });
});

test("session route bootstraps transcript content immediately when session data is present on load", async ({ page }) => {
  const sessionId = "11111111-1111-4111-8111-111111111114";
  const runId = "22222222-2222-4222-8222-222222222222";

  await page.addInitScript((bootstrap) => {
    (window as Window & {
      __ALPHABOOK_ASSISTANT_SESSION_BOOTSTRAP__?: unknown;
    }).__ALPHABOOK_ASSISTANT_SESSION_BOOTSTRAP__ = bootstrap;
  }, {
    sessionId,
    sessions: [
      {
        id: sessionId,
        userId: "local-user",
        title: "Bootstrap session",
        createdAt: "2026-03-16T12:00:00.000Z",
        lastMessageAt: "2026-03-16T12:00:00.000Z",
        lastMessagePreview: "Bootstrap session",
      },
    ],
    messages: [
      {
        id: "user-msg",
        sessionId,
        role: "user",
        content: "What does this session already know?",
        createdAt: "2026-03-16T12:00:00.000Z",
        citations: [],
        toolCalls: [],
      },
      {
        id: "assistant-msg",
        sessionId,
        role: "assistant",
        content: "It already has transcript content at page load.",
        createdAt: "2026-03-16T12:00:01.000Z",
        citations: [],
        toolCalls: [],
      },
    ],
    runs: [
      {
        id: runId,
        sessionId,
        startedAt: "2026-03-16T12:00:01.000Z",
        status: "completed",
      },
    ],
    runState: {
      run: {
        id: runId,
        sessionId,
        startedAt: "2026-03-16T12:00:01.000Z",
        status: "completed",
      },
      artifacts: [
        {
          id: "artifact-1",
          runId,
          filename: "research-document.html",
          content: "<p>Bootstrap research document.</p>",
          createdAt: "2026-03-16T12:00:02.000Z",
          metadata: {
            kind: "research_document",
          },
        },
      ],
    },
  });

  await page.route("**/api/me", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authConfigured: true,
        authenticated: true,
        user: {
          id: "local-user",
          email: "local@example.com",
          name: "Local User",
        },
      }),
    });
  });

  await page.route("**/api/admin/access", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        allowed: false,
        authenticated: true,
        authConfigured: true,
        user: {
          id: "local-user",
          email: "local@example.com",
          name: "Local User",
        },
      }),
    });
  });

  await page.goto(`/?view=assistant&session=${sessionId}`, { waitUntil: "domcontentloaded" });

  await expect(page.getByText("It already has transcript content at page load.")).toBeVisible();
  await expect(page.getByText("Bootstrap research document.")).toBeVisible();
});

test("work route bootstraps the reader iframe immediately on load", async ({ page }) => {
  const workId = "591240be-ecf2-4c48-966a-57531a341da0";

  await page.addInitScript((bootstrap) => {
    (window as Window & {
      __ALPHABOOK_WORK_PAGE_BOOTSTRAP__?: unknown;
    }).__ALPHABOOK_WORK_PAGE_BOOTSTRAP__ = bootstrap;
  }, {
    workId,
    work: {
      id: workId,
      title: "Bootstrap Work",
      authors: ["Author"],
      gutenbergId: "12345",
      hasCoverImage: false,
      coverImageUrl: null,
      firstPublishedYear: null,
      language: "en",
      rightsStatus: "public_domain",
      subjects: [],
      summaries: [],
      metadata: {},
    },
    source: null,
  });

  await page.route("**/api/me", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authConfigured: true,
        authenticated: false,
        user: null,
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

  await page.goto(`/works/${workId}`, { waitUntil: "domcontentloaded" });

  await expect(page.locator(".book-reader-frame-empty")).toHaveCount(0);
  await expect(page.locator(".book-reader-frame")).toBeVisible();
  await expect(page.locator(".book-reader-frame")).toHaveAttribute("src", /12345/);
});

test("restricted assistant session keeps the session URL and shows a coherent locked state", async ({ page }) => {
  const sessionId = "ba4020e7-f283-4976-853f-27146997bf6f";

  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authConfigured: true,
        authenticated: false,
        user: null,
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

  await page.route(`**/api/sessions/${sessionId}/messages`, async (route) => {
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Not authorized for this session.",
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/runs`, async (route) => {
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Not authorized for this session.",
      }),
    });
  });

  await page.goto(`/?view=assistant&session=${sessionId}`);

  await expect(page).toHaveURL(new RegExp(`session=${sessionId}`));
  const thread = page.getByTestId("thread");
  await expect(thread.getByRole("heading", { name: "Sign in to view this conversation." })).toBeVisible();
  await expect(thread.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(thread.getByTestId("empty-state")).toHaveCount(0);
});

test("switching sessions replaces the transcript instead of mixing messages from both chats", async ({ page }) => {
  const firstSessionId = "11111111-1111-4111-8111-111111111201";
  const secondSessionId = "11111111-1111-4111-8111-111111111202";

  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authConfigured: false,
        authenticated: false,
        user: null,
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
        authConfigured: false,
        user: null,
      }),
    });
  });

  await page.route(/\/api\/sessions(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          {
            id: firstSessionId,
            userId: "local-user",
            title: "First thread",
            createdAt: "2026-03-16T12:00:00.000Z",
            lastMessageAt: "2026-03-16T12:01:00.000Z",
            lastMessagePreview: "First thread preview",
          },
          {
            id: secondSessionId,
            userId: "local-user",
            title: "Second thread",
            createdAt: "2026-03-16T12:02:00.000Z",
            lastMessageAt: "2026-03-16T12:03:00.000Z",
            lastMessagePreview: "Second thread preview",
          },
        ],
      }),
    });
  });

  await page.route(`**/api/sessions/${firstSessionId}/messages`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        messages: [
          {
            id: "21111111-1111-4111-8111-111111111201",
            sessionId: firstSessionId,
            role: "user",
            content: "FIRST THREAD QUESTION",
            metadata: {},
            createdAt: "2026-03-16T12:00:00.000Z",
          },
          {
            id: "21111111-1111-4111-8111-111111111202",
            sessionId: firstSessionId,
            role: "assistant",
            content: "FIRST THREAD ANSWER",
            metadata: {},
            createdAt: "2026-03-16T12:00:05.000Z",
          },
        ],
      }),
    });
  });

  await page.route(`**/api/sessions/${secondSessionId}/messages`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        messages: [
          {
            id: "22222222-1111-4111-8111-111111111201",
            sessionId: secondSessionId,
            role: "user",
            content: "SECOND THREAD QUESTION",
            metadata: {},
            createdAt: "2026-03-16T12:02:00.000Z",
          },
          {
            id: "22222222-1111-4111-8111-111111111202",
            sessionId: secondSessionId,
            role: "assistant",
            content: "SECOND THREAD ANSWER",
            metadata: {},
            createdAt: "2026-03-16T12:02:05.000Z",
          },
        ],
      }),
    });
  });

  await page.route(`**/api/sessions/${firstSessionId}/runs`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runs: [] }),
    });
  });

  await page.route(`**/api/sessions/${secondSessionId}/runs`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runs: [] }),
    });
  });

  await page.goto(`/?view=assistant&session=${firstSessionId}`);
  await expect(page.getByText("FIRST THREAD QUESTION")).toBeVisible();
  await expect(page.getByText("FIRST THREAD ANSWER")).toBeVisible();

  await page.getByRole("button", { name: "Second thread" }).click();

  await expect(page).toHaveURL(new RegExp(`session=${secondSessionId}`));
  await expect(page.getByText("SECOND THREAD QUESTION")).toBeVisible();
  await expect(page.getByText("SECOND THREAD ANSWER")).toBeVisible();
  await expect(page.getByText("FIRST THREAD QUESTION")).toHaveCount(0);
  await expect(page.getByText("FIRST THREAD ANSWER")).toHaveCount(0);
});

test("sidebar recents shows a spinner for a session with an active run", async ({ page }) => {
  const firstSessionId = "11111111-1111-4111-8111-111111111211";
  const secondSessionId = "11111111-1111-4111-8111-111111111212";

  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authConfigured: false,
        authenticated: false,
        user: null,
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
        authConfigured: false,
        user: null,
      }),
    });
  });

  await page.route(/\/api\/sessions(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          {
            id: firstSessionId,
            userId: "local-user",
            title: "Running thread",
            createdAt: "2026-03-16T12:00:00.000Z",
            lastMessageAt: "2026-03-16T12:01:00.000Z",
            lastMessagePreview: "Running thread preview",
            activeRunStatus: "running",
          },
          {
            id: secondSessionId,
            userId: "local-user",
            title: "Idle thread",
            createdAt: "2026-03-16T12:02:00.000Z",
            lastMessageAt: "2026-03-16T12:03:00.000Z",
            lastMessagePreview: "Idle thread preview",
            activeRunStatus: null,
          },
        ],
      }),
    });
  });

  await page.route(`**/api/sessions/${firstSessionId}/messages`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ messages: [] }),
    });
  });

  await page.route(`**/api/sessions/${secondSessionId}/messages`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ messages: [] }),
    });
  });

  await page.route(`**/api/sessions/${firstSessionId}/runs`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runs: [] }),
    });
  });

  await page.route(`**/api/sessions/${secondSessionId}/runs`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runs: [] }),
    });
  });

  await page.goto(`/?view=assistant&session=${secondSessionId}`);

  await expect(page.getByTestId(`recent-session-spinner-${firstSessionId}`)).toBeVisible();
  await expect(page.getByTestId(`recent-session-spinner-${secondSessionId}`)).toHaveCount(0);
});

test("assistant session thread stays scrollable with long history", async ({ page }) => {
  const sessionId = "11111111-1111-4111-8111-111111111114";
  const longMessages = Array.from({ length: 18 }, (_, index) => ({
    id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    sessionId,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `${index % 2 === 0 ? "Question" : "Answer"} ${index + 1}: ${"Long scrolling content. ".repeat(18)}`,
    metadata: {},
    createdAt: `2026-03-16T12:${String(index).padStart(2, "0")}:00.000Z`,
  }));

  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authConfigured: false,
        authenticated: false,
        user: null,
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
        authConfigured: false,
        user: null,
      }),
    });
  });

  await page.route(/\/api\/sessions(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          {
            id: sessionId,
            userId: "local-user",
            title: "Long thread",
            createdAt: "2026-03-16T12:00:00.000Z",
            lastMessageAt: "2026-03-16T12:17:00.000Z",
            lastMessagePreview: "Long thread",
          },
        ],
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/messages`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        messages: longMessages,
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/runs`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runs: [],
      }),
    });
  });

  await page.goto(`/?view=assistant&session=${sessionId}`);

  const viewport = page.locator(".assistant-session-thread .aui-thread-viewport");
  const threadRoot = page.locator(".assistant-session-thread > .aui-thread-root");
  const threadShell = page.locator('[data-testid="assistant-workspace-thread"]');
  await expect(viewport).toBeVisible();
  const widths = await Promise.all([
    threadRoot.evaluate((node) => node.getBoundingClientRect().width),
    threadShell.evaluate((node) => node.getBoundingClientRect().width),
  ]);
  expect(widths[0]).toBeGreaterThan(widths[1] * 0.8);
  const before = await viewport.evaluate((node) => ({ scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }));
  expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);
  await viewport.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  const after = await viewport.evaluate((node) => node.scrollTop);
  expect(after).toBeGreaterThan(before.scrollTop);
});

test("assistant shows a friendly error notice instead of raw JSON", async ({ page }) => {
  await page.route("**/api/sessions*", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: "duplicate key value violates unique constraint \"users_email_key\"",
      }),
    });
  });

  await page.goto("/");

  await expect(page.getByText("Account Sync Issue")).toBeVisible();
  await expect(page.getByText("We hit an account sync problem while loading this page. Please refresh and try signing in again.")).toBeVisible();
  await expect(page.getByText(/duplicate key value violates unique constraint/)).toHaveCount(0);
});

test("assistant.completed replaces a partial streamed answer with the final answer text", async ({ page }) => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const userMessageId = "22222222-2222-4222-8222-222222222222";
  const planMessageId = "33333333-3333-4333-8333-333333333333";
  const answer = "Partial opening. Full ending sentence.";

  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authConfigured: false,
        authenticated: false,
        user: null,
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
        authConfigured: false,
        user: null,
      }),
    });
  });

  await page.route(/\/api\/sessions(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          {
            id: sessionId,
            userId: "local-user",
            title: "Existing thread",
            createdAt: "2026-03-16T12:00:00.000Z",
            lastMessageAt: "2026-03-16T12:00:00.000Z",
            lastMessagePreview: "Existing thread",
            activeRunStatus: null,
          },
        ],
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/messages`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        messages: [],
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/runs`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runs: [],
      }),
    });
  });

  await page.route("**/api/chat", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: {
        "cache-control": "no-cache",
      },
      body: [
        'event: run.started\ndata: {"runId":"run-123"}\n\n',
        `event: assistant.plan\ndata: {"messageId":"${planMessageId}","text":"Search quote references."}\n\n`,
        'event: assistant.delta\ndata: {"text":"Partial opening. "}\n\n',
        `event: assistant.completed\ndata: ${JSON.stringify({ answer, citations: [], phase: "answer" })}\n\n`,
        'event: run.completed\ndata: {"runId":"run-123","status":"completed"}\n\n',
      ].join(""),
    });
  });

  await page.goto(`/?view=assistant&session=${sessionId}`);

  await page.locator(".aui-composer-input").fill("Finish this answer.");
  await page.locator(".aui-composer-send").click();

  await expect(page.locator(".aui-assistant-message-root").last()).toContainText(answer);
  await expect(page.locator(".aui-assistant-message-root").last()).not.toContainText(/^Partial opening\.\s*$/);
  await expect(page.locator(".aui-user-message-root").last()).toContainText("Finish this answer.");
  await expect(page.locator(".aui-assistant-message-root").first()).toContainText("Search quote references.");
});


test("sidebar recents shows and clears the spinner during an optimistic send lifecycle", async ({ page }) => {
  const sessionId = "11111111-1111-4111-8111-111111111213";
  const planMessageId = "33333333-3333-4333-8333-333333333335";
  let releaseChatResponse!: () => void;
  const chatResponseReady = new Promise<void>((resolve) => {
    releaseChatResponse = resolve;
  });

  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authConfigured: false,
        authenticated: false,
        user: null,
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
        authConfigured: false,
        user: null,
      }),
    });
  });

  await page.route(/\/api\/sessions(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          {
            id: sessionId,
            userId: "local-user",
            title: "Existing thread",
            createdAt: "2026-03-16T12:00:00.000Z",
            lastMessageAt: "2026-03-16T12:00:00.000Z",
            lastMessagePreview: "Existing thread",
          },
        ],
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/messages`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ messages: [] }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/runs`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ runs: [] }),
    });
  });

  await page.route("**/api/chat", async (route) => {
    await chatResponseReady;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: {
        "cache-control": "no-cache",
      },
      body: [
        'event: run.started\ndata: {"runId":"run-optimistic-1"}\n\n',
        `event: assistant.plan\ndata: {"messageId":"${planMessageId}","text":"Search quote references."}\n\n`,
        'event: assistant.completed\ndata: {"answer":"Done.","citations":[],"phase":"answer"}\n\n',
        'event: run.completed\ndata: {"runId":"run-optimistic-1","status":"completed"}\n\n',
      ].join(""),
    });
  });

  await page.goto(`/?view=assistant&session=${sessionId}`);

  await page.locator(".aui-composer-input").fill("Start the run.");
  await page.locator(".aui-composer-send").click();

  await expect(page.getByTestId(`recent-session-spinner-${sessionId}`)).toBeVisible();
  releaseChatResponse();
  await expect(page.locator(".aui-assistant-message-root").last()).toContainText("Done.");
  await expect(page.getByTestId(`recent-session-spinner-${sessionId}`)).toHaveCount(0);
});

test("new Hermes chat keeps the optimistic thread visible while the created session hydrates", async ({ page }) => {
  const sessionId = "11111111-1111-4111-8111-111111111214";
  const runId = "run-hermes-optimistic-1";

  await page.addInitScript(({ sessionId: bootstrapSessionId, runId: bootstrapRunId }) => {
    const originalFetch = window.fetch.bind(window);
    let bootstrapRequestCount = 0;

    window.fetch = async (input, init) => {
      const url = typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : String(input);

      if (url.endsWith("/api/chat")) {
        const encoder = new TextEncoder();
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`event: session.created\ndata: ${JSON.stringify({
              sessionId: bootstrapSessionId,
              title: "New Hermes thread",
            })}\n\n`));
            controller.enqueue(encoder.encode(`event: run.started\ndata: ${JSON.stringify({ runId: bootstrapRunId })}\n\n`));
            window.setTimeout(() => {
              controller.enqueue(encoder.encode(`event: assistant.completed\ndata: ${JSON.stringify({
                answer: "Hermes is running the deeper research pass.",
                citations: [],
                phase: "answer",
              })}\n\n`));
              controller.enqueue(encoder.encode(`event: run.completed\ndata: ${JSON.stringify({
                runId: bootstrapRunId,
                status: "completed",
              })}\n\n`));
              controller.close();
            }, 300);
          },
        });

        return new Response(body, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          },
        });
      }

      if (url.endsWith(`/api/sessions/${bootstrapSessionId}/bootstrap`)) {
        bootstrapRequestCount += 1;
        await new Promise((resolve) => window.setTimeout(resolve, 100));
        const messages = bootstrapRequestCount === 1
          ? []
          : [
              {
                id: "user-hermes-1",
                sessionId: bootstrapSessionId,
                role: "user",
                content: "Start a Hermes run.",
                createdAt: "2026-03-16T12:00:00.000Z",
                citations: [],
                toolCalls: [],
              },
              {
                id: "assistant-hermes-1",
                sessionId: bootstrapSessionId,
                role: "assistant",
                content: "Hermes is running the deeper research pass.",
                createdAt: "2026-03-16T12:00:01.000Z",
                citations: [],
                toolCalls: [],
                metadata: {
                  phase: "answer",
                },
              },
            ];
        const runs = [
          {
            id: bootstrapRunId,
            sessionId: bootstrapSessionId,
            status: bootstrapRequestCount === 1 ? "running" : "completed",
            plannerTurns: 0,
            startedAt: "2026-03-16T12:00:00.000Z",
            completedAt: bootstrapRequestCount === 1 ? null : "2026-03-16T12:00:02.000Z",
          },
        ];
        return new Response(JSON.stringify({
          sessionId: bootstrapSessionId,
          sessions: [
            {
              id: bootstrapSessionId,
              userId: "local-user",
              title: "New Hermes thread",
              createdAt: "2026-03-16T12:00:00.000Z",
              lastMessageAt: "2026-03-16T12:00:00.000Z",
              lastMessagePreview: "Start a Hermes run.",
              activeRunStatus: bootstrapRequestCount === 1 ? "running" : null,
            },
          ],
          messages,
          runs,
          runState: {
            artifacts: [],
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }

      return originalFetch(input, init);
    };
  }, { sessionId, runId });

  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authConfigured: false,
        authenticated: false,
        user: null,
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
        authConfigured: false,
        user: null,
      }),
    });
  });

  await page.route(/\/api\/sessions(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [],
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/runs`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runs: [
          {
            id: runId,
            sessionId,
            status: "running",
            plannerTurns: 0,
            startedAt: "2026-03-16T12:00:00.000Z",
            completedAt: null,
          },
        ],
      }),
    });
  });

  await page.goto("/?view=assistant");

  await page.locator(".aui-composer-input").fill("Start a Hermes run.");
  await page.locator(".aui-composer-send").click();

  await expect(page.locator(".aui-user-message-root").last()).toContainText("Start a Hermes run.");
  await page.waitForTimeout(180);
  await expect(page.locator(".aui-user-message-root").last()).toContainText("Start a Hermes run.");
  await expect(page.getByTestId("empty-state")).toHaveCount(0);
  await expect(page.locator(".assistant-thread-shell")).toBeVisible();
});

test("reloading a session keeps streamed tool progress instead of replacing it with sparse run state", async ({ page }) => {
  const sessionId = "11111111-1111-4111-8111-111111111112";
  const runId = "run-progress-1";
  const planMessageId = "33333333-3333-4333-8333-333333333334";
  const toolCallId = "tool-progress-1";

  await page.addInitScript((bootstrap) => {
    (window as Window & {
      __ALPHABOOK_ASSISTANT_SESSION_BOOTSTRAP__?: unknown;
    }).__ALPHABOOK_ASSISTANT_SESSION_BOOTSTRAP__ = bootstrap;
  }, {
    sessionId,
    sessions: [
      {
        id: sessionId,
        userId: "local-user",
        title: "Existing thread",
        createdAt: "2026-03-16T12:00:00.000Z",
        lastMessageAt: "2026-03-16T12:00:00.000Z",
        lastMessagePreview: "Existing thread",
      },
    ],
    messages: [
      {
        id: planMessageId,
        sessionId,
        role: "assistant",
        content: "I searched the corpus and deeper workspace.",
        metadata: {
          phase: "plan",
          runId,
          toolCalls: [
            {
              id: toolCallId,
              toolName: "get_relevant_chunks",
              label: "Passage Search",
              rationale: "Looking for grief scenes.",
              progress: [
                "Pulled 12 candidate passages.",
                "Ranked the strongest passages for synthesis.",
              ],
              args: {
                __logLines: [
                  "Search quote: 'grief scenes in 19th century fiction'",
                ],
              },
              result: {
                __logLines: [
                  "Selected 5 passages for the final comparison.",
                ],
              },
              state: "completed",
            },
          ],
        },
        createdAt: "2026-03-16T12:00:01.000Z",
      },
    ],
    runs: [
      {
        id: runId,
        sessionId,
        status: "completed",
        plannerTurns: 4,
        startedAt: "2026-03-16T12:00:00.000Z",
        completedAt: "2026-03-16T12:00:10.000Z",
      },
    ],
    runState: {
      run: {
        id: runId,
        sessionId,
        status: "completed",
        plannerTurns: 4,
        startedAt: "2026-03-16T12:00:00.000Z",
        completedAt: "2026-03-16T12:00:10.000Z",
      },
      toolTrace: [
        {
          id: toolCallId,
          toolName: "get_relevant_chunks",
          label: "Passage Search",
          progress: [],
          args: {
            __logLines: [
              "Search quote: 'grief scenes in 19th century fiction'",
            ],
          },
          result: {
            __logLines: [
              "Selected 5 passages for the final comparison.",
            ],
          },
          state: "completed",
        },
      ],
      artifacts: [],
    },
  });

  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authConfigured: false,
        authenticated: false,
        user: null,
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
        authConfigured: false,
        user: null,
      }),
    });
  });

  await page.route("**/api/sessions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          {
            id: sessionId,
            userId: "local-user",
            title: "Existing thread",
            createdAt: "2026-03-16T12:00:00.000Z",
            lastMessageAt: "2026-03-16T12:00:00.000Z",
            lastMessagePreview: "Existing thread",
          },
        ],
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/messages`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        messages: [
          {
            id: planMessageId,
            sessionId,
            role: "assistant",
            content: "I searched the corpus and deeper workspace.",
            metadata: {
              phase: "plan",
              runId,
              toolCalls: [
                {
                  id: toolCallId,
                  toolName: "get_relevant_chunks",
                  label: "Passage Search",
                  rationale: "Looking for grief scenes.",
                  progress: [
                    "Pulled 12 candidate passages.",
                    "Ranked the strongest passages for synthesis.",
                  ],
                  args: {
                    __logLines: [
                      "Search quote: 'grief scenes in 19th century fiction'",
                    ],
                  },
                  result: {
                    __logLines: [
                      "Selected 5 passages for the final comparison.",
                    ],
                  },
                  state: "completed",
                },
              ],
            },
            createdAt: "2026-03-16T12:00:01.000Z",
          },
        ],
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/runs`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runs: [
          {
            id: runId,
            sessionId,
            status: "completed",
            plannerTurns: 4,
            startedAt: "2026-03-16T12:00:00.000Z",
            completedAt: "2026-03-16T12:00:10.000Z",
          },
        ],
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/runs/${runId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        run: {
          id: runId,
          sessionId,
          status: "completed",
          plannerTurns: 4,
          startedAt: "2026-03-16T12:00:00.000Z",
          completedAt: "2026-03-16T12:00:10.000Z",
        },
        toolTrace: [
          {
            id: toolCallId,
            toolName: "get_relevant_chunks",
            label: "Passage Search",
            progress: [],
            args: {
              __logLines: [
                "Search quote: 'grief scenes in 19th century fiction'",
              ],
            },
            result: {
              __logLines: [
                "Selected 5 passages for the final comparison.",
              ],
            },
            state: "completed",
          },
        ],
        artifacts: [],
      }),
    });
  });

  await page.goto(`/?view=assistant&session=${sessionId}`);

  await page.getByText("Passage Search").click();
  await expect(page.getByText("Pulled 12 candidate passages.")).toBeVisible();
  await expect(page.getByText("Ranked the strongest passages for synthesis.")).toBeVisible();
  await expect(page.getByText("Selected 5 passages for the final comparison.")).toBeVisible();
});

test("failed tool calls show a failed status instead of looking completed", async ({ page }) => {
  const sessionId = "11111111-1111-4111-8111-111111111119";
  const runId = "22222222-2222-4222-8222-222222222229";

  await page.addInitScript((bootstrap) => {
    (window as Window & {
      __ALPHABOOK_ASSISTANT_SESSION_BOOTSTRAP__?: unknown;
    }).__ALPHABOOK_ASSISTANT_SESSION_BOOTSTRAP__ = bootstrap;
  }, {
    sessionId,
    sessions: [
      {
        id: sessionId,
        userId: "local-user",
        title: "Failed retrieval",
        createdAt: "2026-03-16T12:00:00.000Z",
        lastMessageAt: "2026-03-16T12:00:00.000Z",
        lastMessagePreview: "Failed retrieval",
      },
    ],
    messages: [
      {
        id: "33333333-3333-4333-8333-333333333339",
        sessionId,
        role: "assistant",
        content: "I searched and one step failed.",
        metadata: {
          phase: "plan",
          runId,
          toolCalls: [
            {
              id: "failed-tool",
              toolName: "get_relevant_chunks",
              label: "Passage Search",
              rationale: "Broadening the search.",
              progress: ["Broadening the search."],
              result: {
                ok: false,
                error: "Passage search timed out before the database returned chunks.",
              },
            },
          ],
        },
        createdAt: "2026-03-16T12:00:01.000Z",
      },
    ],
    runs: [
      {
        id: runId,
        sessionId,
        status: "failed",
        plannerTurns: 2,
        startedAt: "2026-03-16T12:00:00.000Z",
        completedAt: "2026-03-16T12:00:10.000Z",
      },
    ],
    runState: {
      run: {
        id: runId,
        sessionId,
        status: "failed",
        plannerTurns: 2,
        startedAt: "2026-03-16T12:00:00.000Z",
        completedAt: "2026-03-16T12:00:10.000Z",
      },
      toolTrace: [
        {
          id: "failed-tool",
          toolName: "get_relevant_chunks",
          label: "Passage Search",
          progress: ["Broadening the search."],
          result: {
            ok: false,
            error: "Passage search timed out before the database returned chunks.",
          },
          state: "error",
        },
      ],
      artifacts: [],
    },
  });

  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authConfigured: true,
        authenticated: true,
        user: {
          id: "local-user",
          email: "local@example.com",
          name: "Local User",
        },
      }),
    });
  });

  await page.route("**/api/admin/access", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        allowed: false,
        authenticated: true,
        authConfigured: true,
        user: {
          id: "local-user",
          email: "local@example.com",
          name: "Local User",
        },
      }),
    });
  });

  await page.route("**/api/sessions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          {
            id: sessionId,
            userId: "local-user",
            title: "Failed retrieval",
            createdAt: "2026-03-16T12:00:00.000Z",
            lastMessageAt: "2026-03-16T12:00:00.000Z",
            lastMessagePreview: "Failed retrieval",
          },
        ],
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/messages`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        messages: [
          {
            id: "33333333-3333-4333-8333-333333333339",
            sessionId,
            role: "assistant",
            content: "I searched and one step failed.",
            metadata: {
              phase: "plan",
              runId,
              toolCalls: [
                {
                  id: "failed-tool",
                  toolName: "get_relevant_chunks",
                  label: "Passage Search",
                  rationale: "Broadening the search.",
                  progress: ["Broadening the search."],
                  result: {
                    ok: false,
                    error: "Passage search timed out before the database returned chunks.",
                  },
                },
              ],
            },
            createdAt: "2026-03-16T12:00:01.000Z",
          },
        ],
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/runs`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runs: [
          {
            id: runId,
            sessionId,
            status: "failed",
            plannerTurns: 3,
            startedAt: "2026-03-16T12:00:00.000Z",
            completedAt: "2026-03-16T12:00:05.000Z",
          },
        ],
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/runs/${runId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        run: {
          id: runId,
          sessionId,
          status: "failed",
          plannerTurns: 3,
          startedAt: "2026-03-16T12:00:00.000Z",
          completedAt: "2026-03-16T12:00:05.000Z",
        },
        toolTrace: [
          {
            id: "failed-tool",
            toolName: "get_relevant_chunks",
            label: "Passage Search",
            progress: ["Broadening the search."],
            result: {
              ok: false,
              error: "Passage search timed out before the database returned chunks.",
            },
          },
        ],
        artifacts: [],
      }),
    });
  });

  await page.goto(`/?view=assistant&session=${sessionId}`);

  await expect(page.getByRole("button", { name: /Passage Search Failed/ })).toBeVisible();
});

test("semantic search shows AlphaLoop progress and citations instead of a static fallback", async ({ page }) => {
  const sessionId = "11111111-1111-4111-8111-111111111129";
  const runId = "22222222-2222-4222-8222-222222222239";

  await page.addInitScript((bootstrap) => {
    (window as Window & {
      __ALPHABOOK_ASSISTANT_SESSION_BOOTSTRAP__?: unknown;
    }).__ALPHABOOK_ASSISTANT_SESSION_BOOTSTRAP__ = bootstrap;
  }, {
    sessionId,
    sessions: [
      {
        id: sessionId,
        userId: "local-user",
        title: "Semantic thread",
        createdAt: "2026-03-26T12:00:00.000Z",
        lastMessageAt: "2026-03-26T12:00:00.000Z",
        lastMessagePreview: "Semantic thread",
      },
    ],
    messages: [
      {
        id: "33333333-3333-4333-8333-333333333349",
        sessionId,
        role: "assistant",
        content: "I ran semantic search.",
        metadata: {
          phase: "plan",
          runId,
          toolCalls: [
            {
              id: "semantic-tool-1",
              toolName: "semantic_deep_search",
              label: "Semantic Search",
              rationale: "Re-ranked 18 passages and kept 6 of them.",
              progress: [
                "Searching the semantic index for “grief and consolation” (22 matches).",
                "Re-ranked 18 passages and kept 6 of them.",
              ],
              progressDetails: [
                {
                  type: "semantic.alphaloop",
                  event: {
                    type: "embedding_search",
                    query: "grief and consolation",
                    chunksFound: 22,
                  },
                },
                {
                  type: "semantic.alphaloop",
                  event: {
                    type: "rerank",
                    totalChunks: 18,
                    keptChunks: 6,
                    droppedChunks: 12,
                  },
                },
              ],
              result: {
                briefing: "The loop found several strong passages.",
                chunks: [
                  {
                    id: "chunk-1",
                    text: "She found consolation in the shared ritual of mourning.",
                    relevance: 0.91,
                    workId: "work-1",
                    chunkIndex: 14,
                  },
                ],
              },
              state: "completed",
            },
          ],
        },
        createdAt: "2026-03-26T12:00:01.000Z",
      },
    ],
    runs: [
      {
        id: runId,
        sessionId,
        status: "completed",
        plannerTurns: 1,
        startedAt: "2026-03-26T12:00:00.000Z",
        completedAt: "2026-03-26T12:00:05.000Z",
      },
    ],
    runState: {
      run: {
        id: runId,
        sessionId,
        status: "completed",
        plannerTurns: 1,
        startedAt: "2026-03-26T12:00:00.000Z",
        completedAt: "2026-03-26T12:00:05.000Z",
      },
      toolTrace: [],
      artifacts: [],
    },
  });

  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authConfigured: false,
        authenticated: false,
        user: null,
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
        authConfigured: false,
        user: null,
      }),
    });
  });

  await page.route("**/api/sessions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          {
            id: sessionId,
            userId: "local-user",
            title: "Semantic thread",
            createdAt: "2026-03-26T12:00:00.000Z",
            lastMessageAt: "2026-03-26T12:00:00.000Z",
            lastMessagePreview: "Semantic thread",
          },
        ],
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/messages`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        messages: [
          {
            id: "33333333-3333-4333-8333-333333333349",
            sessionId,
            role: "assistant",
            content: "I ran semantic search.",
            metadata: {
              phase: "plan",
              runId,
              toolCalls: [
                {
                  id: "semantic-tool-1",
                  toolName: "semantic_deep_search",
                  label: "Semantic Search",
                  rationale: "Re-ranked 18 passages and kept 6 of them.",
                  progress: [
                    "Searching the semantic index for “grief and consolation” (22 matches).",
                    "Re-ranked 18 passages and kept 6 of them.",
                  ],
                  progressDetails: [
                    {
                      type: "semantic.alphaloop",
                      event: {
                        type: "embedding_search",
                        query: "grief and consolation",
                        chunksFound: 22,
                      },
                    },
                    {
                      type: "semantic.alphaloop",
                      event: {
                        type: "rerank",
                        totalChunks: 18,
                        keptChunks: 6,
                        droppedChunks: 12,
                      },
                    },
                  ],
                  result: {
                    briefing: "The loop found several strong passages.",
                    chunks: [
                      {
                        id: "chunk-1",
                        text: "She found consolation in the shared ritual of mourning.",
                        relevance: 0.91,
                        workId: "work-1",
                        chunkIndex: 14,
                      },
                    ],
                  },
                  state: "completed",
                },
              ],
            },
            createdAt: "2026-03-26T12:00:01.000Z",
          },
        ],
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/runs`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runs: [
          {
            id: runId,
            sessionId,
            status: "completed",
            plannerTurns: 1,
            startedAt: "2026-03-26T12:00:00.000Z",
            completedAt: "2026-03-26T12:00:05.000Z",
          },
        ],
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/runs/${runId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        run: {
          id: runId,
          sessionId,
          status: "completed",
          plannerTurns: 1,
          startedAt: "2026-03-26T12:00:00.000Z",
          completedAt: "2026-03-26T12:00:05.000Z",
        },
        toolTrace: [],
        artifacts: [],
      }),
    });
  });

  await page.goto(`/?view=assistant&session=${sessionId}`);

  await expect(page.getByText('Searching for "grief and consolation"')).toBeVisible();
  await expect(page.getByText("Re-ranking")).toBeVisible();
  await expect(page.getByText("Sources (1)")).toBeVisible();
  await expect(page.getByText("91% match")).toBeVisible();
  await expect(page.getByRole("button", { name: /Semantic Search/ })).toHaveCount(0);
});

test("active Hermes plan messages keep the thread running dot while the run is still active", async ({ page }) => {
  const sessionId = "11111111-1111-4111-8111-111111111130";
  const runId = "22222222-2222-4222-8222-222222222240";
  const planMessageId = "33333333-3333-4333-8333-333333333350";

  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authConfigured: true,
        authenticated: true,
        user: {
          id: "local-user",
          email: "local@example.com",
          name: "Local User",
        },
      }),
    });
  });

  await page.route("**/api/admin/access", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        allowed: false,
        authenticated: true,
        authConfigured: true,
        user: {
          id: "local-user",
          email: "local@example.com",
          name: "Local User",
        },
      }),
    });
  });

  await page.route("**/api/sessions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          {
            id: sessionId,
            userId: "local-user",
            title: "Hermes thread",
            createdAt: "2026-03-26T12:00:00.000Z",
            lastMessageAt: "2026-03-26T12:00:00.000Z",
            lastMessagePreview: "How do authors deal with grief?",
            activeRunStatus: "running",
          },
        ],
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/messages`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        messages: [
          {
            id: planMessageId,
            sessionId,
            role: "assistant",
            content: "Starting a Hermes research run on this thread and streaming the tool activity here.",
            metadata: {
              phase: "plan",
              runId,
              hermes: {
                jobId: "job-hermes-active",
                sessionId: "hermes-session",
                model: "gpt-5.4",
              },
            },
            createdAt: "2026-03-26T12:00:01.000Z",
          },
        ],
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/runs`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runs: [
          {
            id: runId,
            sessionId,
            status: "running",
            plannerTurns: 1,
            startedAt: "2026-03-26T12:00:00.000Z",
            completedAt: null,
          },
        ],
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/runs/${runId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        run: {
          id: runId,
          sessionId,
          status: "running",
          plannerTurns: 1,
          startedAt: "2026-03-26T12:00:00.000Z",
          completedAt: null,
        },
        toolTrace: [],
        artifacts: [],
      }),
    });
  });

  await page.goto(`/?view=assistant&session=${sessionId}`);

  const message = page.locator(".aui-assistant-message-root").filter({
    hasText: "Starting a Hermes research run on this thread and streaming the tool activity here.",
  });
  await expect(message.locator(".aui-assistant-running-indicator")).toBeVisible();
  await expect(page.locator(".aui-assistant-running-indicator")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
});

test("existing Hermes sessions do not show running dots before transcript bootstrap finishes", async ({ page }) => {
  const sessionId = "11111111-1111-4111-8111-111111111131";
  const runId = "22222222-2222-4222-8222-222222222241";
  const planMessageId = "33333333-3333-4333-8333-333333333351";

  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authConfigured: true,
        authenticated: true,
        user: {
          id: "local-user",
          email: "local@example.com",
          name: "Local User",
        },
      }),
    });
  });

  await page.route("**/api/admin/access", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        allowed: false,
        authenticated: true,
        authConfigured: true,
        user: {
          id: "local-user",
          email: "local@example.com",
          name: "Local User",
        },
      }),
    });
  });

  await page.route("**/api/sessions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          {
            id: sessionId,
            userId: "local-user",
            title: "Hermes bootstrap thread",
            createdAt: "2026-03-26T12:00:00.000Z",
            lastMessageAt: "2026-03-26T12:00:00.000Z",
            lastMessagePreview: "How do authors deal with grief?",
            activeRunStatus: "running",
          },
        ],
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/bootstrap`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessionId,
        sessions: [
          {
            id: sessionId,
            userId: "local-user",
            title: "Hermes bootstrap thread",
            createdAt: "2026-03-26T12:00:00.000Z",
            lastMessageAt: "2026-03-26T12:00:00.000Z",
            lastMessagePreview: "How do authors deal with grief?",
            activeRunStatus: "running",
          },
        ],
        messages: [
          {
            id: planMessageId,
            sessionId,
            role: "assistant",
            content: "Starting a Hermes research run on this thread and streaming the tool activity here.",
            metadata: {
              phase: "plan",
              runId,
              hermes: {
                jobId: "job-hermes-bootstrap",
                sessionId: "hermes-session",
                model: "gpt-5.4",
              },
            },
            createdAt: "2026-03-26T12:00:01.000Z",
            citations: [],
            toolCalls: [],
          },
        ],
        runs: [
          {
            id: runId,
            sessionId,
            status: "running",
            plannerTurns: 1,
            startedAt: "2026-03-26T12:00:00.000Z",
            completedAt: null,
          },
        ],
        runState: {
          artifacts: [],
        },
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/runs`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runs: [
          {
            id: runId,
            sessionId,
            status: "running",
            plannerTurns: 1,
            startedAt: "2026-03-26T12:00:00.000Z",
            completedAt: null,
          },
        ],
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/runs/${runId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        run: {
          id: runId,
          sessionId,
          status: "running",
          plannerTurns: 1,
          startedAt: "2026-03-26T12:00:00.000Z",
          completedAt: null,
        },
        toolTrace: [],
        artifacts: [],
      }),
    });
  });

  await page.goto(`/?view=assistant&session=${sessionId}`, { waitUntil: "domcontentloaded" });

  await expect(page.locator(".aui-assistant-message-root")).toHaveCount(0);
  await expect(page.locator(".aui-assistant-running-indicator")).toHaveCount(0);

  const message = page.locator(".aui-assistant-message-root").filter({
    hasText: "Starting a Hermes research run on this thread and streaming the tool activity here.",
  });
  await expect(message).toBeVisible();
});

test("recovered tool traces keep friendly log lines after refresh", async ({ page }) => {
  const sessionId = "11111111-1111-4111-8111-111111111129";
  const runId = "22222222-2222-4222-8222-222222222239";

  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authConfigured: true,
        authenticated: true,
        user: {
          id: "local-user",
          email: "local@example.com",
          name: "Local User",
        },
      }),
    });
  });

  await page.route("**/api/admin/access", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        allowed: false,
        authenticated: true,
        authConfigured: true,
        user: {
          id: "local-user",
          email: "local@example.com",
          name: "Local User",
        },
      }),
    });
  });

  await page.route("**/api/sessions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          {
            id: sessionId,
            userId: "local-user",
            title: "Recovered trace",
            createdAt: "2026-03-16T12:00:00.000Z",
            lastMessageAt: "2026-03-16T12:00:00.000Z",
            lastMessagePreview: "Recovered trace",
          },
        ],
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/messages`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        messages: [
          {
            id: "33333333-3333-4333-8333-333333333349",
            sessionId,
            role: "assistant",
            content: "Recovered message.",
            metadata: {
              phase: "plan",
              runId,
              toolCalls: [
                {
                  id: "metadata-tool",
                  toolName: "search_works",
                  label: "Metadata Search",
                  progress: [],
                  args: {
                    __logLines: [
                      { key: "", value: "Checking titles, summaries, subjects, and catalog metadata for 'grief in fiction'" },
                    ],
                  },
                  result: {
                    __logLines: [
                      { key: "", value: "Checking titles, summaries, subjects, and catalog metadata for 'grief in fiction' found 20 candidate books." },
                    ],
                  },
                  state: "completed",
                },
              ],
            },
            createdAt: "2026-03-16T12:00:01.000Z",
          },
        ],
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/runs`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runs: [
          {
            id: runId,
            sessionId,
            status: "completed",
            plannerTurns: 3,
            startedAt: "2026-03-16T12:00:00.000Z",
            completedAt: "2026-03-16T12:00:05.000Z",
          },
        ],
      }),
    });
  });

  await page.route(`**/api/sessions/${sessionId}/runs/${runId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        run: {
          id: runId,
          sessionId,
          status: "completed",
          plannerTurns: 3,
          startedAt: "2026-03-16T12:00:00.000Z",
          completedAt: "2026-03-16T12:00:05.000Z",
        },
        toolTrace: [
          {
            id: "metadata-tool",
            toolName: "search_works",
            label: "Metadata Search",
            progress: [],
            args: {
              __logLines: [
                { key: "", value: "Checking titles, summaries, subjects, and catalog metadata for 'grief in fiction'" },
              ],
            },
            result: {
              __logLines: [
                { key: "", value: "Checking titles, summaries, subjects, and catalog metadata for 'grief in fiction' found 20 candidate books." },
              ],
            },
            state: "completed",
          },
        ],
        artifacts: [],
      }),
    });
  });

  await page.goto(`/?view=assistant&session=${sessionId}`);

  const metadataCard = page.getByRole("button", { name: /Metadata Search Done/i });
  await metadataCard.click();
  const metadataPanel = metadataCard.locator("xpath=ancestor::*[contains(@class,'aui-tool-fallback-root')][1]");
  await expect(metadataPanel.getByText("Checking titles, summaries, subjects, and catalog metadata for 'grief in fiction'").first()).toBeVisible();
  await expect(metadataPanel.getByText("Checking titles, summaries, subjects, and catalog metadata for 'grief in fiction' found 20 candidate books.").first()).toBeVisible();
  await expect(page.getByText(/^workCount$/)).toHaveCount(0);
  await expect(page.getByText(/^works$/)).toHaveCount(0);
});

test("full assistant flow keeps the final briefing and tool details after refresh", async ({ page }) => {
  await page.goto("/");

  await page.locator(".aui-composer-input").fill("Compare how Don Quixote and Moby-Dick talk about grief.");
  await page.locator(".aui-composer-send").click();

  const planMessage = page.locator(".aui-assistant-message-root").first();
  const finalMessage = page.locator(".aui-assistant-message-root").last();

  await expect(planMessage).toContainText(/Research Setup/i);
  await expect(planMessage).toContainText(/Corpus Search/i);
  await expect(planMessage).toContainText(/Passage Search/i);
  await expect(finalMessage).toContainText(/Workspace Summary/i);
  await expect(finalMessage).toContainText(/Don Quixote/i);
  await expect(finalMessage).toContainText(/Moby-Dick/i);
  await expect(finalMessage).not.toHaveText(/^\s*$/);

  await planMessage.getByText("Passage Search").click();
  await expect(planMessage).toContainText(/Pulling a few seed passages from across the corpus/i);

  await page.reload();

  const reloadedPlanMessage = page.locator(".aui-assistant-message-root").first();
  const reloadedFinalMessage = page.locator(".aui-assistant-message-root").last();

  await expect(reloadedPlanMessage).toContainText(/Research Setup/i);
  await expect(reloadedPlanMessage).toContainText(/Corpus Search/i);
  await expect(reloadedPlanMessage).toContainText(/Passage Search/i);
  await expect(reloadedFinalMessage).toContainText(/Workspace Summary/i);
  await expect(reloadedFinalMessage).toContainText(/Don Quixote/i);
  await expect(reloadedFinalMessage).toContainText(/Moby-Dick/i);

  await reloadedPlanMessage.getByText("Passage Search").click();
  await expect(reloadedPlanMessage).toContainText(/Pulling a few seed passages from across the corpus/i);
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

  test("recent sessions show run completion state and clear it after opening", async ({ page }) => {
    const sessionId = "11111111-1111-4111-8111-111111111112";
    const failedSessionId = "22222222-1111-4111-8111-111111111112";

    await page.route(/\/(?:api\/)?me$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          authConfigured: true,
          authenticated: true,
          user: {
            id: "local-user",
            email: "local@example.com",
            handle: "local-user",
            name: "Local User",
            avatarUrl: null,
            createdAt: "2026-03-20T12:00:00.000Z",
            followersCount: 0,
            followingCount: 0,
          },
        }),
      });
    });

    await page.route(/\/(?:api\/)?admin\/access$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          allowed: false,
          authenticated: true,
          authConfigured: true,
          user: {
            id: "local-user",
            email: "local@example.com",
            handle: "local-user",
            name: "Local User",
            avatarUrl: null,
            createdAt: "2026-03-20T12:00:00.000Z",
            followersCount: 0,
            followingCount: 0,
          },
        }),
      });
    });

    await page.route(/\/(?:api\/)?sessions$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessions: [
            {
              id: sessionId,
              userId: "local-user",
              title: "Melville notes",
              createdAt: "2026-03-20T11:00:00.000Z",
              lastMessageAt: "2026-03-20T12:00:00.000Z",
              lastMessagePreview: "Summarize the symbolism of the sea.",
              activeRunStatus: null,
            },
            {
              id: failedSessionId,
              userId: "local-user",
              title: "Whitman draft",
              createdAt: "2026-03-20T10:00:00.000Z",
              lastMessageAt: "2026-03-20T11:00:00.000Z",
              lastMessagePreview: "Compare Whitman's catalog structure.",
              activeRunStatus: null,
            },
          ],
        }),
      });
    });

    await page.route(new RegExp(`/((?:api/)?)sessions/${sessionId}/messages$`), async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ messages: [] }),
      });
    });

    await page.route(new RegExp(`/((?:api/)?)sessions/${sessionId}/runs$`), async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ runs: [] }),
      });
    });

    await page.route(/\/(?:api\/)?notifications$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          unreadCount: 1,
          notifications: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              userId: "local-user",
              sessionId,
              runId: "11111111-1111-4111-8111-111111111113",
              toolCallId: null,
              type: "run_completed",
              title: "Research complete",
              body: "Your research run is ready.",
              metadata: {
                label: "Run",
              },
              readAt: null,
              emailedAt: "2026-03-20T12:00:00.000Z",
              createdAt: "2026-03-20T12:00:00.000Z",
            },
            {
              id: "22222222-2222-4222-8222-222222222222",
              userId: "local-user",
              sessionId: failedSessionId,
              runId: "22222222-1111-4111-8111-111111111113",
              toolCallId: null,
              type: "run_failed",
              title: "Research failed",
              body: "A different run failed.",
              metadata: {
                label: "Run",
              },
              readAt: null,
              emailedAt: null,
              createdAt: "2026-03-20T11:00:00.000Z",
            },
          ],
        }),
      });
    });

    await page.route(/\/(?:api\/)?notifications\/.+\/read$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto("/");

    await page.getByLabel("Open navigation").click();
    await expect(page.getByTestId("sidebar")).toHaveClass(/is-open/);
    await expect(page.getByRole("button", { name: /Melville notes/ })).toBeVisible();
    await expect(page.getByTestId(`recent-session-notification-completed-${sessionId}`)).toBeVisible();
    await expect(page.getByTestId(`recent-session-notification-error-${failedSessionId}`)).toBeVisible();

    await page.getByRole("button", { name: /Melville notes/ }).click();
    await expect(page.getByTestId(`recent-session-notification-completed-${sessionId}`)).toHaveCount(0);
  });
});
