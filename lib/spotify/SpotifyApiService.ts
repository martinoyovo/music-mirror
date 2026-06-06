import type {
  SpotifyTrackAudioAnalysis,
  SpotifyCurrentlyPlaying,
  SpotifyRecentlyPlayedItem,
  SpotifyRecentlyPlayedResponse,
  SpotifyUserProfile,
} from "./types";

export class SpotifyApiService {
  private static baseUrl = "https://api.spotify.com/v1";

  static async getUserProfile(accessToken: string) {
    return this.request<SpotifyUserProfile>("/me", accessToken);
  }

  static async getCurrentlyPlaying(accessToken: string) {
    return this.request<SpotifyCurrentlyPlaying | null>(
      "/me/player/currently-playing",
      accessToken,
      { allowEmpty: true },
    );
  }

  static async getRecentlyPlayed(accessToken: string, limit = 20) {
    return this.request<SpotifyRecentlyPlayedResponse>(
      `/me/player/recently-played?limit=${limit}`,
      accessToken,
    );
  }

  static async getTrackAudioAnalysis(accessToken: string, trackId: string) {
    return this.request<SpotifyTrackAudioAnalysis | null>(
      `/audio-analysis/${trackId}`,
      accessToken,
      { allowStatuses: [403, 404] },
    );
  }

  static async getRecentlyPlayedRange(
    accessToken: string,
    {
      endMs,
      maxPages = 6,
      startMs,
    }: {
      endMs: number;
      maxPages?: number;
      startMs: number;
    },
  ) {
    const items: SpotifyRecentlyPlayedItem[] = [];
    const seen = new Set<string>();
    let before = endMs + 1;
    let reachedRequestedStart = false;

    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.request<SpotifyRecentlyPlayedResponse>(
        `/me/player/recently-played?limit=50&before=${before}`,
        accessToken,
      );

      if (response.items.length === 0) {
        break;
      }

      for (const item of response.items) {
        const playedAtMs = new Date(item.played_at).getTime();
        const key = `${item.track.id}:${item.played_at}`;

        if (seen.has(key)) {
          continue;
        }

        seen.add(key);

        if (playedAtMs <= endMs && playedAtMs >= startMs) {
          items.push(item);
        }
      }

      const oldestItem = response.items[response.items.length - 1];
      if (!oldestItem) {
        break;
      }

      const oldestPlayedAtMs = new Date(oldestItem.played_at).getTime();
      if (oldestPlayedAtMs < startMs) {
        reachedRequestedStart = true;
        break;
      }

      before = oldestPlayedAtMs;

      if (response.items.length < 50) {
        break;
      }
    }

    return {
      items,
      reachedRequestedStart,
    };
  }

  private static async request<T>(
    path: string,
    accessToken: string,
    options?: { allowEmpty?: boolean; allowStatuses?: number[] },
  ) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (options?.allowEmpty && response.status === 204) {
      return null as T;
    }

    if (options?.allowStatuses?.includes(response.status)) {
      return null as T;
    }

    if (!response.ok) {
      throw new Error(`Spotify request failed with ${response.status}.`);
    }

    return (await response.json()) as T;
  }
}
