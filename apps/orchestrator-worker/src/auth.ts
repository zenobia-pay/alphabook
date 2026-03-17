import { WorkOS } from "@workos-inc/node";
import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import { serialize } from "cookie";

import type { AppStore, UserRecord } from "./store";

const SESSION_COOKIE_NAME = "alphabook_session";
const STATE_COOKIE_NAME = "alphabook_auth_state";

interface PendingAuthState {
  state: string;
  codeVerifier: string;
  returnTo: string;
}

export interface AuthConfig {
  workosApiKey: string;
  workosClientId: string;
  cookiePassword: string;
}

interface AuthenticatedSessionCookie {
  sessionId?: string;
  session?: {
    id?: string;
  };
  user?: {
    id?: string;
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    profilePictureUrl?: string | null;
  };
}

function deriveCookieDomain(url: URL): string | undefined {
  if (url.hostname === "alpha-book.org" || url.hostname.endsWith(".alpha-book.org")) {
    return ".alpha-book.org";
  }
  return undefined;
}

function deriveFrontendOrigin(url: URL): string {
  if (url.hostname === "api.alpha-book.org") {
    return "https://alpha-book.org";
  }
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    return "http://127.0.0.1:4193";
  }
  if (url.hostname.startsWith("api.")) {
    return `${url.protocol}//${url.hostname.slice(4)}`;
  }
  return `${url.protocol}//${url.hostname}`;
}

function safeReturnTo(value: string | null | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }
  try {
    const url = new URL(value);
    if (url.hostname === "alpha-book.org" || url.hostname.endsWith(".alpha-book.org")) {
      return url.toString();
    }
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      return url.toString();
    }
  } catch {
    return fallback;
  }
  return fallback;
}

function encodeStateCookie(state: PendingAuthState): string {
  return btoa(JSON.stringify(state));
}

function decodeStateCookie(value: string | undefined): PendingAuthState | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(atob(value)) as Partial<PendingAuthState>;
    if (
      typeof parsed.state !== "string" ||
      typeof parsed.codeVerifier !== "string" ||
      typeof parsed.returnTo !== "string"
    ) {
      return null;
    }
    return {
      state: parsed.state,
      codeVerifier: parsed.codeVerifier,
      returnTo: parsed.returnTo,
    };
  } catch {
    return null;
  }
}

function displayNameFromUser(user: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}) {
  const name = [user.firstName ?? "", user.lastName ?? ""].join(" ").trim();
  if (name.length > 0) {
    return name;
  }
  return user.email ?? "AlphaBook Reader";
}

function sessionIdFromCookieSession(session: AuthenticatedSessionCookie | null | undefined): string | null {
  if (!session || typeof session !== "object") {
    return null;
  }
  if (typeof session.sessionId === "string" && session.sessionId.length > 0) {
    return session.sessionId;
  }
  if (typeof session.session?.id === "string" && session.session.id.length > 0) {
    return session.session.id;
  }
  return null;
}

function clearCookies(c: Context, cookieNames: string[], cookieDomain?: string) {
  for (const name of cookieNames) {
    c.header("Set-Cookie", serialize(name, "", {
      path: "/",
      maxAge: 0,
    }), { append: true });
    if (cookieDomain) {
      c.header("Set-Cookie", serialize(name, "", {
        path: "/",
        domain: cookieDomain,
        maxAge: 0,
      }), { append: true });
    }
  }
}

function clearAuthCookies(c: Context, cookieDomain?: string) {
  clearCookies(c, [SESSION_COOKIE_NAME, STATE_COOKIE_NAME], cookieDomain);
}

function clearPendingAuthState(c: Context, cookieDomain?: string) {
  clearCookies(c, [STATE_COOKIE_NAME], cookieDomain);
}

export class WorkOSAuth {
  private readonly workos: WorkOS;

  constructor(
    private readonly config: AuthConfig,
    private readonly store: AppStore,
  ) {
    this.workos = new WorkOS(config.workosApiKey);
  }

  isConfigured() {
    return Boolean(this.config.workosApiKey && this.config.workosClientId && this.config.cookiePassword);
  }

  async getCurrentUser(c: Context): Promise<UserRecord | null> {
    const sessionData = getCookie(c, SESSION_COOKIE_NAME);
    if (!sessionData) {
      return null;
    }

    try {
      const session = await this.workos.userManagement.getSessionFromCookie({
        sessionData,
        cookiePassword: this.config.cookiePassword,
      });
      if (!session?.user?.id) {
        return null;
      }
      return this.store.upsertUserProfile({
        id: session.user.id,
        email: session.user.email ?? null,
        name: displayNameFromUser(session.user),
        avatarUrl: session.user.profilePictureUrl ?? null,
      });
    } catch {
      return null;
    }
  }

  private async beginAuth(c: Context, screenHint?: "sign-in" | "sign-up") {
    const requestUrl = new URL(c.req.url);
    const cookieDomain = deriveCookieDomain(requestUrl);
    const returnTo = safeReturnTo(c.req.query("returnTo"), deriveFrontendOrigin(requestUrl));
    const redirectUri = `${requestUrl.origin}/auth/callback`;
    const prompt = c.req.query("prompt") || (screenHint === "sign-in" ? "login" : undefined);
    const { url, state, codeVerifier } = await this.workos.userManagement.getAuthorizationUrlWithPKCE({
      provider: "authkit",
      clientId: this.config.workosClientId,
      redirectUri,
      ...(prompt ? { prompt } : {}),
      ...(screenHint ? { screenHint } : {}),
    });

    setCookie(c, STATE_COOKIE_NAME, encodeStateCookie({ state, codeVerifier, returnTo }), {
      httpOnly: true,
      secure: requestUrl.protocol === "https:",
      sameSite: "Lax",
      path: "/",
      maxAge: 60 * 10,
      ...(cookieDomain ? { domain: cookieDomain } : {}),
    });

    return c.redirect(url, 302);
  }

  async signIn(c: Context) {
    return this.beginAuth(c, "sign-in");
  }

  async signUp(c: Context) {
    return this.beginAuth(c, "sign-up");
  }

  async callback(c: Context) {
    const requestUrl = new URL(c.req.url);
    const cookieDomain = deriveCookieDomain(requestUrl);
    const code = c.req.query("code");
    const state = c.req.query("state");
    const pendingState = decodeStateCookie(getCookie(c, STATE_COOKIE_NAME));
    const fallbackReturnTo = deriveFrontendOrigin(requestUrl);
    const returnTo = safeReturnTo(pendingState?.returnTo, fallbackReturnTo);

    if (!code || !state || !pendingState || pendingState.state !== state) {
      clearAuthCookies(c, cookieDomain);
      return c.redirect(`${returnTo}?auth_error=state_mismatch`, 302);
    }

    try {
      const authResponse = await this.workos.userManagement.authenticateWithCode({
        clientId: this.config.workosClientId,
        code,
        codeVerifier: pendingState.codeVerifier,
        session: {
          sealSession: true,
          cookiePassword: this.config.cookiePassword,
        },
      });
      if (!authResponse.sealedSession) {
        throw new Error("WorkOS did not return a sealed session.");
      }

      setCookie(c, SESSION_COOKIE_NAME, authResponse.sealedSession, {
        httpOnly: true,
        secure: requestUrl.protocol === "https:",
        sameSite: "Lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
        ...(cookieDomain ? { domain: cookieDomain } : {}),
      });
      clearPendingAuthState(c, cookieDomain);

      await this.store.upsertUserProfile({
        id: authResponse.user.id,
        email: authResponse.user.email ?? null,
        name: displayNameFromUser(authResponse.user),
        avatarUrl: authResponse.user.profilePictureUrl ?? null,
      });

      return c.redirect(returnTo, 302);
    } catch {
      clearAuthCookies(c, cookieDomain);
      return c.redirect(`${returnTo}?auth_error=callback_failed`, 302);
    }
  }

  async signOut(c: Context): Promise<string> {
    const requestUrl = new URL(c.req.url);
    const cookieDomain = deriveCookieDomain(requestUrl);
    const returnTo = safeReturnTo(c.req.query("returnTo"), deriveFrontendOrigin(requestUrl));
    const sessionData = getCookie(c, SESSION_COOKIE_NAME);

    let logoutUrl = returnTo;
    if (sessionData) {
      try {
        const session = await this.workos.userManagement.getSessionFromCookie({
          sessionData,
          cookiePassword: this.config.cookiePassword,
        }) as AuthenticatedSessionCookie | undefined;
        const sessionId = sessionIdFromCookieSession(session ?? null);
        if (sessionId) {
          logoutUrl = this.workos.userManagement.getLogoutUrl({
            sessionId,
            returnTo,
          });
        }
      } catch {
        logoutUrl = returnTo;
      }
    }

    clearAuthCookies(c, cookieDomain);

    return logoutUrl;
  }
}
