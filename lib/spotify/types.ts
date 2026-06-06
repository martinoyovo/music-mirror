export type SpotifyImage = {
  height?: number | null;
  url: string;
  width?: number | null;
};

export type SpotifyArtist = {
  id?: string;
  name: string;
};

export type SpotifyAlbum = {
  images: SpotifyImage[];
  name: string;
};

export type SpotifyTrack = {
  album: SpotifyAlbum;
  artists: SpotifyArtist[];
  duration_ms: number;
  id: string;
  name: string;
  type: "track";
};

export type SpotifyUserProfile = {
  country?: string;
  display_name: string | null;
  id: string;
  images?: SpotifyImage[];
  product?: string;
};

export type SpotifyCurrentlyPlaying = {
  is_playing: boolean;
  item: SpotifyTrack | null;
  progress_ms: number | null;
};

export type SpotifyRecentlyPlayedItem = {
  played_at: string;
  track: SpotifyTrack;
};

export type SpotifyRecentlyPlayedResponse = {
  cursors?: {
    after?: string;
    before?: string;
  };
  items: SpotifyRecentlyPlayedItem[];
  next?: string | null;
};

export type SpotifyAudioAnalysisSection = {
  confidence: number;
  duration: number;
  loudness: number;
  start: number;
  tempo: number;
};

export type SpotifyTrackAudioAnalysis = {
  sections: SpotifyAudioAnalysisSection[];
  track: {
    duration: number;
    loudness: number;
    tempo: number;
  };
};

export type SpotifyToken = {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
  scope: string;
  tokenType: string;
};

export type MoodName =
  | "Calm"
  | "Uplifting"
  | "Reflective"
  | "Energetic"
  | "Focused"
  | "Moody";

export type ThemeName =
  | "Spiritual"
  | "Romance"
  | "Nostalgia"
  | "Confidence"
  | "Community"
  | "Rest";

export type DashboardTrack = {
  albumImageUrl?: string;
  artist: string;
  durationMs: number;
  id: string;
  name: string;
  playedAt?: string;
  progressMs?: number | null;
};

export type DashboardMood = {
  color: string;
  label: MoodName;
  value: number;
};

export type DashboardTrend = {
  day: string;
  dateKey?: string;
  height: string;
  mood: string;
  plays: number;
};

export type DashboardObservation = {
  detail: string;
  icon: "sunrise" | "activity" | "waves";
  positive: boolean;
  title: string;
  trend: string;
};

export type DashboardData = {
  currentMood: {
    description: string;
    label: MoodName;
    score: number;
    timeListenedToday: string;
    trendLabel: string;
  };
  moodBreakdown: DashboardMood[];
  themeSignal: {
    description: string;
    label: ThemeName | null;
    strength: number;
  };
  nowPlaying: {
    durationLabel: string;
    energy: string;
    isPlaying: boolean;
    mood: string;
    progressLabel: string;
    progressPercent: number;
    sourceLabel: string;
    tempo: string;
    track?: DashboardTrack;
  };
  observations: DashboardObservation[];
  profile?: SpotifyUserProfile;
  reflection: {
    body: string;
    headline: string;
    summary: string;
  };
  recentTracks: DashboardTrack[];
  weeklyTrend: DashboardTrend[];
};
