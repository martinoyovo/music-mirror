import type { SpotifyToken } from "./types";

const TOKEN_KEY = "musicMirror.spotifyToken";
const CODE_VERIFIER_KEY = "musicMirror.spotifyCodeVerifier";
const STATE_KEY = "musicMirror.spotifyAuthState";

const SCOPES = [
  "user-read-private",
  "user-read-currently-playing",
  "user-read-playback-state",
  "user-read-recently-played",
];

type SpotifyTokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
};

type AuthConfig = {
  clientId: string;
  redirectUri: string;
};

export class SpotifyAuthService {
  static getConfig(): AuthConfig {
    const fallbackRedirectUri = this.getDefaultRedirectUri();
    const configuredRedirectUri = this.getConfiguredRedirectUri();

    return {
      clientId: process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID?.trim() ?? "",
      redirectUri: this.normalizeRedirectUri(configuredRedirectUri || fallbackRedirectUri),
    };
  }

  static getScopes() {
    return SCOPES;
  }

  static isConfigured() {
    const { clientId, redirectUri } = this.getConfig();
    return Boolean(clientId && redirectUri);
  }

  static ensurePreferredLocalOrigin() {
    if (typeof window === "undefined") {
      return false;
    }

    const preferredOrigin = this.getPreferredLocalOrigin();
    if (!preferredOrigin || window.location.origin === preferredOrigin) {
      return false;
    }

    const nextUrl = new URL(window.location.href);
    const parsedPreferredOrigin = new URL(preferredOrigin);
    nextUrl.protocol = parsedPreferredOrigin.protocol;
    nextUrl.hostname = parsedPreferredOrigin.hostname;
    nextUrl.port = parsedPreferredOrigin.port;
    window.location.replace(nextUrl.toString());
    return true;
  }

  static getStoredToken(): SpotifyToken | null {
    if (typeof window === "undefined") {
      return null;
    }

    const rawToken = window.localStorage.getItem(TOKEN_KEY);
    if (!rawToken) {
      return null;
    }

    try {
      return JSON.parse(rawToken) as SpotifyToken;
    } catch {
      this.disconnect();
      return null;
    }
  }

  static async getValidToken() {
    const token = this.getStoredToken();
    if (!token) {
      return null;
    }

    if (Date.now() < token.expiresAt - 30_000) {
      return token.accessToken;
    }

    if (!token.refreshToken) {
      this.disconnect();
      return null;
    }

    const refreshed = await this.refreshAccessToken(token.refreshToken);
    return refreshed.accessToken;
  }

  static async connect() {
    const { clientId, redirectUri } = this.getConfig();
    if (!clientId || !redirectUri) {
      throw new Error("Missing Spotify environment variables.");
    }

    if (this.ensurePreferredLocalOrigin()) {
      return;
    }

    const codeVerifier = this.generateRandomString(64);
    const codeChallenge = await this.createCodeChallenge(codeVerifier);
    const state = this.generateRandomString(32);

    window.localStorage.setItem(CODE_VERIFIER_KEY, codeVerifier);
    window.localStorage.setItem(STATE_KEY, state);

    const authUrl = new URL("https://accounts.spotify.com/authorize");
    authUrl.search = new URLSearchParams({
      client_id: clientId,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      state,
    }).toString();

    window.location.href = authUrl.toString();
  }

  static async completeRedirectIfNeeded() {
    if (typeof window === "undefined") {
      return null;
    }

    const params = new URLSearchParams(window.location.search);
    const error = params.get("error");
    const code = params.get("code");
    const state = params.get("state");

    if (error) {
      this.clearOAuthScratch();
      this.clearUrlParams();
      throw new Error(`Spotify authorization failed: ${error}`);
    }

    if (!code) {
      return null;
    }

    const storedState = window.localStorage.getItem(STATE_KEY);
    const codeVerifier = window.localStorage.getItem(CODE_VERIFIER_KEY);

    if (!storedState || storedState !== state || !codeVerifier) {
      this.clearOAuthScratch();
      this.clearUrlParams();
      throw new Error("Spotify authorization state did not match.");
    }

    const token = await this.exchangeCodeForToken(code, codeVerifier);
    this.storeToken(token);
    this.clearOAuthScratch();
    this.clearUrlParams();

    return token;
  }

  static disconnect() {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.removeItem(TOKEN_KEY);
    this.clearOAuthScratch();
  }

  static getPreferredAppUrl(pathname = "/") {
    if (typeof window === "undefined") {
      return pathname;
    }

    const preferredOrigin = this.getPreferredLocalOrigin();
    if (!preferredOrigin) {
      return new URL(pathname, window.location.origin).toString();
    }

    return new URL(pathname, preferredOrigin).toString();
  }

  private static async exchangeCodeForToken(code: string, codeVerifier: string) {
    const { clientId, redirectUri } = this.getConfig();
    const response = await fetch("https://accounts.spotify.com/api/token", {
      body: new URLSearchParams({
        client_id: clientId,
        code,
        code_verifier: codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    if (!response.ok) {
      throw new Error("Spotify token exchange failed.");
    }

    return this.toStoredToken((await response.json()) as SpotifyTokenResponse);
  }

  private static async refreshAccessToken(refreshToken: string) {
    const { clientId } = this.getConfig();
    const response = await fetch("https://accounts.spotify.com/api/token", {
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    if (!response.ok) {
      this.disconnect();
      throw new Error("Spotify token refresh failed.");
    }

    const nextToken = this.toStoredToken(
      (await response.json()) as SpotifyTokenResponse,
      refreshToken,
    );
    this.storeToken(nextToken);
    return nextToken;
  }

  private static toStoredToken(
    response: SpotifyTokenResponse,
    fallbackRefreshToken?: string,
  ): SpotifyToken {
    return {
      accessToken: response.access_token,
      expiresAt: Date.now() + response.expires_in * 1000,
      refreshToken: response.refresh_token ?? fallbackRefreshToken,
      scope: response.scope,
      tokenType: response.token_type,
    };
  }

  private static storeToken(token: SpotifyToken) {
    window.localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
  }

  private static clearOAuthScratch() {
    window.localStorage.removeItem(CODE_VERIFIER_KEY);
    window.localStorage.removeItem(STATE_KEY);
  }

  private static clearUrlParams() {
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  private static generateRandomString(length: number) {
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-~";
    const values = window.crypto.getRandomValues(new Uint8Array(length));
    return Array.from(values, (value) => possible[value % possible.length]).join("");
  }

  private static async createCodeChallenge(codeVerifier: string) {
    const data = new TextEncoder().encode(codeVerifier);
    const digest = await window.crypto.subtle.digest("SHA-256", data);
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  }

  private static normalizeRedirectUri(redirectUri: string) {
    if (typeof window === "undefined") {
      return redirectUri;
    }

    try {
      const parsedRedirectUri = new URL(redirectUri);
      const currentOrigin = window.location.origin;
      const isLocalhost = parsedRedirectUri.hostname === "localhost";
      const isLocalRedirectHost = this.isLocalBrowserHost(parsedRedirectUri.hostname);
      const isCurrentHostLocal = this.isLocalBrowserHost(window.location.hostname);

      if (!isCurrentHostLocal && isLocalRedirectHost) {
        return `${window.location.origin}/callback`;
      }

      if (
        isCurrentHostLocal &&
        (parsedRedirectUri.origin === currentOrigin || isLocalhost) &&
        (parsedRedirectUri.pathname === "/" ||
          parsedRedirectUri.pathname === "" ||
          parsedRedirectUri.pathname === "/callback")
      ) {
        return `${this.getLocalLoopbackOrigin(parsedRedirectUri)}/callback`;
      }

      if (
        parsedRedirectUri.origin === currentOrigin &&
        (parsedRedirectUri.pathname === "/" ||
          parsedRedirectUri.pathname === "" ||
          parsedRedirectUri.pathname === "/callback")
      ) {
        return `${currentOrigin}/callback`;
      }
    } catch {
      return redirectUri;
    }

    return redirectUri;
  }

  private static getDefaultRedirectUri() {
    if (typeof window === "undefined") {
      return "";
    }

    if (this.isLocalBrowserHost(window.location.hostname)) {
      return `${this.getLocalLoopbackOrigin(window.location)}/callback`;
    }

    return `${window.location.origin}/callback`;
  }

  private static getLocalLoopbackOrigin(url: URL | Location) {
    const port = url.port ? `:${url.port}` : "";
    return `${url.protocol}//127.0.0.1${port}`;
  }

  private static getPreferredLocalOrigin() {
    if (typeof window === "undefined") {
      return null;
    }

    if (!this.isLocalBrowserHost(window.location.hostname)) {
      return null;
    }

    const configuredRedirectUri = this.getConfiguredRedirectUri();
    if (configuredRedirectUri) {
      try {
        const redirectUrl = new URL(configuredRedirectUri);
        if (this.isLocalBrowserHost(redirectUrl.hostname)) {
          return this.getLocalLoopbackOrigin(redirectUrl);
        }
      } catch {
        return null;
      }
    }

    return this.getLocalLoopbackOrigin(window.location);
  }

  private static getConfiguredRedirectUri() {
    const configuredRedirectUri = process.env.NEXT_PUBLIC_SPOTIFY_REDIRECT_URI?.trim();

    if (!configuredRedirectUri || typeof window === "undefined") {
      return configuredRedirectUri ?? "";
    }

    try {
      const redirectUrl = new URL(configuredRedirectUri);
      const currentHostIsLocal = this.isLocalBrowserHost(window.location.hostname);
      const configuredHostIsLocal = this.isLocalBrowserHost(redirectUrl.hostname);

      if (!currentHostIsLocal && configuredHostIsLocal) {
        return "";
      }
    } catch {
      return "";
    }

    return configuredRedirectUri;
  }

  private static isLocalBrowserHost(hostname: string) {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  }
}
