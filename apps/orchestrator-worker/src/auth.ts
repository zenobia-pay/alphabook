import { WorkOS } from "@workos-inc/node";
import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import { serialize } from "cookie";

import type { AppStore, UserRecord } from "./store";

interface PendingAuthState {
  state: string;
  codeVerifier: string;
  returnTo: string;
}

export interface AuthConfig {
  workosApiKey: string;
  workosClientId: string;
  cookiePassword: string;
  frontendOrigin?: string;
  apiOrigin?: string;
  cookieDomain?: string;
  cookiePrefix?: string;
  allowedHosts?: string[];
  defaultReaderName?: string;
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

function cookiePrefix(config?: AuthConfig) {
  return config?.cookiePrefix?.trim() || "alphabook";
}

function sessionCookieName(config?: AuthConfig) {
  return `${cookiePrefix(config)}_session`;
}

function stateCookieName(config?: AuthConfig) {
  return `${cookiePrefix(config)}_auth_state`;
}

function frontendHost(config?: AuthConfig): string | null {
  if (!config?.frontendOrigin) {
    return null;
  }
  try {
    return new URL(config.frontendOrigin).hostname;
  } catch {
    return null;
  }
}

function derivedCookieDomainFromHost(hostname: string): string | undefined {
  if (
    hostname === "localhost"
    || hostname === "127.0.0.1"
    || /^[0-9.]+$/u.test(hostname)
    || hostname.endsWith(".workers.dev")
  ) {
    return undefined;
  }
  return `.${hostname.replace(/^www\./u, "")}`;
}

function deriveCookieDomain(url: URL, config?: AuthConfig): string | undefined {
  if (config?.cookieDomain) {
    return config.cookieDomain;
  }
  const configuredFrontendHost = frontendHost(config);
  if (configuredFrontendHost) {
    return derivedCookieDomainFromHost(configuredFrontendHost);
  }
  if (url.hostname.startsWith("api.")) {
    return derivedCookieDomainFromHost(url.hostname.slice(4));
  }
  return derivedCookieDomainFromHost(url.hostname);
}

function deriveFrontendOrigin(url: URL, config?: AuthConfig): string {
  if (config?.frontendOrigin) {
    return config.frontendOrigin;
  }
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

function deriveApiOrigin(url: URL, config?: AuthConfig): string {
  if (config?.apiOrigin) {
    return config.apiOrigin;
  }
  return url.origin;
}

function safeReturnTo(value: string | null | undefined, fallback: string, config?: AuthConfig): string {
  if (!value) {
    return fallback;
  }
  try {
    const url = new URL(value);
    const allowedHosts = new Set(config?.allowedHosts ?? []);
    const configuredFrontendHost = frontendHost(config);
    if (configuredFrontendHost) {
      allowedHosts.add(configuredFrontendHost);
    }
    if (allowedHosts.has(url.hostname)) {
      return url.toString();
    }
    const cookieDomain = deriveCookieDomain(url, config);
    if (cookieDomain && url.hostname.endsWith(cookieDomain.replace(/^\./u, ""))) {
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
}, fallbackName = "AlphaBook Reader") {
  const name = [user.firstName ?? "", user.lastName ?? ""].join(" ").trim();
  if (name.length > 0) {
    return name;
  }
  return user.email ?? fallbackName;
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

function clearAuthCookies(c: Context, config?: AuthConfig, cookieDomain?: string) {
  clearCookies(c, [sessionCookieName(config), stateCookieName(config)], cookieDomain);
}

function clearPendingAuthState(c: Context, config?: AuthConfig, cookieDomain?: string) {
  clearCookies(c, [stateCookieName(config)], cookieDomain);
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
    const sessionData = getCookie(c, sessionCookieName(this.config));
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
        name: displayNameFromUser(session.user, this.config.defaultReaderName),
        avatarUrl: session.user.profilePictureUrl ?? null,
      });
    } catch {
      return null;
    }
  }

  private async beginAuth(c: Context, screenHint?: "sign-in" | "sign-up") {
    const requestUrl = new URL(c.req.url);
    const cookieDomain = deriveCookieDomain(requestUrl, this.config);
    const returnTo = safeReturnTo(c.req.query("returnTo"), deriveFrontendOrigin(requestUrl, this.config), this.config);
    const redirectUri = `${deriveApiOrigin(requestUrl, this.config)}/auth/callback`;
    const prompt = c.req.query("prompt") || (screenHint === "sign-in" ? "login" : undefined);
    const { url, state, codeVerifier } = await this.workos.userManagement.getAuthorizationUrlWithPKCE({
      provider: "authkit",
      clientId: this.config.workosClientId,
      redirectUri,
      ...(prompt ? { prompt } : {}),
      ...(screenHint ? { screenHint } : {}),
    });

    setCookie(c, stateCookieName(this.config), encodeStateCookie({ state, codeVerifier, returnTo }), {
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
    const cookieDomain = deriveCookieDomain(requestUrl, this.config);
    const code = c.req.query("code");
    const state = c.req.query("state");
    const pendingState = decodeStateCookie(getCookie(c, stateCookieName(this.config)));
    const fallbackReturnTo = deriveFrontendOrigin(requestUrl, this.config);
    const returnTo = safeReturnTo(pendingState?.returnTo, fallbackReturnTo, this.config);

    if (!code || !state || !pendingState || pendingState.state !== state) {
      clearAuthCookies(c, this.config, cookieDomain);
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

      setCookie(c, sessionCookieName(this.config), authResponse.sealedSession, {
        httpOnly: true,
        secure: requestUrl.protocol === "https:",
        sameSite: "Lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
        ...(cookieDomain ? { domain: cookieDomain } : {}),
      });
      clearPendingAuthState(c, this.config, cookieDomain);

      await this.store.upsertUserProfile({
        id: authResponse.user.id,
        email: authResponse.user.email ?? null,
        name: displayNameFromUser(authResponse.user),
        avatarUrl: authResponse.user.profilePictureUrl ?? null,
      });

      return c.redirect(returnTo, 302);
    } catch {
      clearAuthCookies(c, this.config, cookieDomain);
      return c.redirect(`${returnTo}?auth_error=callback_failed`, 302);
    }
  }

  async signOut(c: Context): Promise<string> {
    const requestUrl = new URL(c.req.url);
    const cookieDomain = deriveCookieDomain(requestUrl, this.config);
    const returnTo = safeReturnTo(c.req.query("returnTo"), deriveFrontendOrigin(requestUrl, this.config), this.config);
    const sessionData = getCookie(c, sessionCookieName(this.config));

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

    clearAuthCookies(c, this.config, cookieDomain);

    return logoutUrl;
  }
}
