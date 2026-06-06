import type {
  DashboardData,
  DashboardMood,
  DashboardObservation,
  DashboardTrack,
  DashboardTrend,
  MoodName,
  SpotifyCurrentlyPlaying,
  SpotifyRecentlyPlayedItem,
  SpotifyUserProfile,
  ThemeName,
} from "./types";

const moodColors: Record<MoodName, string> = {
  Calm: "bg-[#4ecdc4]",
  Reflective: "bg-[#8ba5ff]",
  Uplifting: "bg-[#ffcd56]",
  Energetic: "bg-[#ff7a5c]",
  Focused: "bg-[#c7f36c]",
  Moody: "bg-[#b58cff]",
};

const moodKeywords: Record<MoodName, string[]> = {
  Calm: ["calm", "quiet", "peace", "still", "soft", "sleep", "gentle", "acoustic"],
  Uplifting: ["sun", "smile", "gold", "glory", "joy", "light", "happy", "shine"],
  Reflective: ["remember", "home", "night", "blue", "dream", "heart", "again"],
  Energetic: ["fire", "dance", "jump", "party", "wild", "fast", "electric"],
  Focused: ["rise", "run", "win", "drive", "work", "power", "victory", "motion", "speed"],
  Moody: ["sad", "cry", "lost", "alone", "rain", "broken", "goodbye", "dark"],
};

const themeKeywords: Record<ThemeName, string[]> = {
  Spiritual: ["worship", "holy", "praise", "grace", "jesus", "god", "spirit", "prayer", "hymn"],
  Romance: ["love", "heart", "kiss", "darling", "baby", "lover", "forever"],
  Nostalgia: ["remember", "home", "yesterday", "again", "old", "childhood", "memory"],
  Confidence: ["win", "power", "boss", "crown", "champion", "fearless", "unstoppable"],
  Community: ["party", "dance", "friends", "together", "crew", "celebrate", "summer"],
  Rest: ["sleep", "dream", "quiet", "midnight", "soft", "rain", "lullaby"],
};

const dayLabels = ["S", "M", "T", "W", "T", "F", "S"];

export function createDashboardData(input: {
  currentlyPlaying: SpotifyCurrentlyPlaying | null;
  rangeEnd?: Date;
  rangeStart?: Date;
  profile?: SpotifyUserProfile;
  recentlyPlayed: SpotifyRecentlyPlayedItem[];
  trendRecentlyPlayed?: SpotifyRecentlyPlayedItem[];
}): DashboardData {
  const nowPlayingTrack =
    input.currentlyPlaying?.item?.type === "track"
      ? toDashboardTrack(input.currentlyPlaying.item, {
          progressMs: input.currentlyPlaying.progress_ms,
        })
      : undefined;
  const recentTracks = input.recentlyPlayed.map((item) =>
    toDashboardTrack(item.track, { playedAt: item.played_at }),
  );
  const hasListeningData = recentTracks.length > 0 || Boolean(nowPlayingTrack);
  const moodCounts = countMoods([
    ...(nowPlayingTrack ? [nowPlayingTrack] : []),
    ...recentTracks,
  ]);
  const themeCounts = countThemes([
    ...(nowPlayingTrack ? [nowPlayingTrack] : []),
    ...recentTracks,
  ]);
  const dominantMood = getDominantMood(moodCounts);
  const moodBreakdown = toMoodBreakdown(moodCounts);
  const listeningMinutes = getListeningMinutesForRange(
    recentTracks,
    input.rangeStart,
    input.rangeEnd,
  );
  const rangeStart = input.rangeStart ?? getDefaultRangeStart();
  const rangeEnd = input.rangeEnd ?? new Date();

  return {
    currentMood: {
      description: createMoodDescription(dominantMood, recentTracks.length, Boolean(nowPlayingTrack)),
      label: dominantMood,
      score: hasListeningData ? getBalanceScore(moodBreakdown) : 0,
      timeListenedToday: formatListeningTime(listeningMinutes, rangeStart, rangeEnd),
      trendLabel: hasListeningData ? createTrendLabel(dominantMood, moodBreakdown) : "No data",
    },
    moodBreakdown,
    themeSignal: createThemeSignal(themeCounts, recentTracks.length, Boolean(nowPlayingTrack)),
    nowPlaying: {
      durationLabel: formatDuration(nowPlayingTrack?.durationMs ?? 0),
      energy: getEnergyLabel(dominantMood),
      isPlaying: Boolean(input.currentlyPlaying?.is_playing && nowPlayingTrack),
      mood: dominantMood,
      progressLabel: formatDuration(nowPlayingTrack?.progressMs ?? 0),
      progressPercent: getProgressPercent(nowPlayingTrack),
      sourceLabel: nowPlayingTrack
        ? input.currentlyPlaying?.is_playing
          ? "Live"
          : "Paused"
        : "Idle",
      tempo: getTempoEstimate(dominantMood),
      track: nowPlayingTrack,
    },
    observations: createObservations(recentTracks, moodBreakdown),
    profile: input.profile,
    reflection: createReflection(dominantMood, recentTracks, nowPlayingTrack),
    recentTracks,
    weeklyTrend: createTrendData(
      input.trendRecentlyPlayed ?? input.recentlyPlayed,
      getDefaultRangeStart(),
      new Date(),
    ),
  };
}

function toDashboardTrack(
  track: SpotifyRecentlyPlayedItem["track"],
  extra: { playedAt?: string; progressMs?: number | null },
): DashboardTrack {
  return {
    albumImageUrl: track.album.images[0]?.url,
    artist: track.artists.map((artist) => artist.name).join(", "),
    durationMs: track.duration_ms,
    id: track.id,
    name: track.name,
    playedAt: extra.playedAt,
    progressMs: extra.progressMs,
  };
}

function countMoods(tracks: DashboardTrack[]) {
  const counts = Object.keys(moodColors).reduce(
    (accumulator, mood) => ({ ...accumulator, [mood]: 0 }),
    {} as Record<MoodName, number>,
  );

  tracks.forEach((track) => {
    counts[inferMood(track)] += 1;
  });

  return counts;
}

function countThemes(tracks: DashboardTrack[]) {
  const counts = Object.keys(themeKeywords).reduce(
    (accumulator, theme) => ({ ...accumulator, [theme]: 0 }),
    {} as Record<ThemeName, number>,
  );

  tracks.forEach((track) => {
    const theme = inferTheme(track);
    if (theme) {
      counts[theme] += 1;
    }
  });

  return counts;
}

function inferMood(track: DashboardTrack): MoodName {
  const searchable = `${track.name} ${track.artist}`.toLowerCase();
  const match = (Object.keys(moodKeywords) as MoodName[]).find((mood) =>
    moodKeywords[mood].some((keyword) => searchable.includes(keyword)),
  );

  if (match) {
    return match;
  }

  const seed = [...track.name].reduce((total, character) => total + character.charCodeAt(0), 0);
  const moods: MoodName[] = ["Calm", "Reflective", "Uplifting", "Energetic", "Focused", "Moody"];
  return moods[seed % moods.length];
}

function inferTheme(track: DashboardTrack): ThemeName | null {
  const searchable = `${track.name} ${track.artist}`.toLowerCase();
  return (
    (Object.keys(themeKeywords) as ThemeName[]).find((theme) =>
      themeKeywords[theme].some((keyword) => searchable.includes(keyword)),
    ) ?? null
  );
}

function getDominantMood(counts: Record<MoodName, number>): MoodName {
  return (Object.entries(counts) as Array<[MoodName, number]>).sort(
    (a, b) => b[1] - a[1],
  )[0][0];
}

function toMoodBreakdown(counts: Record<MoodName, number>): DashboardMood[] {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

  if (total === 0) {
    return (Object.keys(moodColors) as MoodName[]).map((label) => ({
      color: moodColors[label],
      label,
      value: 0,
    }));
  }

  return (Object.keys(moodColors) as MoodName[]).map((label) => ({
    color: moodColors[label],
    label,
    value: Math.max(label === getDominantMood(counts) ? 18 : 3, Math.round((counts[label] / total) * 100)),
  }));
}

function createMoodDescription(mood: MoodName, recentCount: number, hasNowPlaying: boolean) {
  if (recentCount === 0 && !hasNowPlaying) {
    return "No listening history was available for this selection, so there is no mood signal to summarize yet.";
  }

  const source = hasNowPlaying ? "your current track and recent history" : "your recent listening history";
  return `Based on ${source}, your listening is leaning ${mood.toLowerCase()} with a mix of familiar patterns behind it.`;
}

function createThemeSignal(
  counts: Record<ThemeName, number>,
  recentCount: number,
  hasNowPlaying: boolean,
) {
  const topTheme = (Object.entries(counts) as Array<[ThemeName, number]>).sort((a, b) => b[1] - a[1])[0];

  if (!topTheme || topTheme[1] === 0 || (!recentCount && !hasNowPlaying)) {
    return {
      description: "No recurring lyrical or title theme is clear yet.",
      label: null,
      strength: 0,
    };
  }

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0) || 1;
  const strength = Math.round((topTheme[1] / total) * 100);

  return {
    description: `${topTheme[0]} appears most often in the language around these tracks.`,
    label: topTheme[0],
    strength,
  };
}

function getBalanceScore(moods: DashboardMood[]) {
  const topValue = Math.max(...moods.map((mood) => mood.value));
  return Math.max(48, Math.min(96, 100 - Math.round(topValue / 2)));
}

function getListeningMinutesForRange(tracks: DashboardTrack[], rangeStart?: Date, rangeEnd?: Date) {
  const startMs = (rangeStart ?? getDefaultRangeStart()).getTime();
  const endMs = (rangeEnd ?? new Date()).getTime();

  return tracks
    .filter((track) => {
      if (!track.playedAt) {
        return false;
      }

      const playedAtMs = new Date(track.playedAt).getTime();
      return playedAtMs >= startMs && playedAtMs <= endMs;
    })
    .reduce((total, track) => total + track.durationMs / 60_000, 0);
}

function formatListeningTime(minutes: number, rangeStart: Date, rangeEnd: Date) {
  if (minutes < 1) {
    return `0m in ${formatRangeLabel(rangeStart, rangeEnd)}`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = Math.round(minutes % 60);

  if (hours === 0) {
    return `${remainingMinutes}m in ${formatRangeLabel(rangeStart, rangeEnd)}`;
  }

  return `${hours}h ${remainingMinutes}m in ${formatRangeLabel(rangeStart, rangeEnd)}`;
}

function createTrendLabel(mood: MoodName, moods: DashboardMood[]) {
  const value = moods.find((item) => item.label === mood)?.value ?? 0;
  return `${value}% ${mood.toLowerCase()}`;
}

function formatDuration(milliseconds: number) {
  if (!milliseconds) {
    return "0:00";
  }

  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function getProgressPercent(track?: DashboardTrack) {
  if (!track?.progressMs || !track.durationMs) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round((track.progressMs / track.durationMs) * 100)));
}

function getEnergyLabel(mood: MoodName) {
  if (mood === "Energetic" || mood === "Uplifting") {
    return "High";
  }

  if (mood === "Calm" || mood === "Reflective") {
    return "Low";
  }

  return "Mid";
}

function getTempoEstimate(mood: MoodName) {
  const tempos: Record<MoodName, string> = {
    Calm: "76",
    Reflective: "88",
    Uplifting: "108",
    Energetic: "128",
    Focused: "104",
    Moody: "72",
  };
  return tempos[mood];
}

function createReflection(
  mood: MoodName,
  recentTracks: DashboardTrack[],
  nowPlayingTrack?: DashboardTrack,
) {
  if (recentTracks.length === 0 && !nowPlayingTrack) {
    return {
      body: "This selection does not have enough listening history to generate a reflection yet.",
      headline: "No listening data for this selection",
      summary: "Try another day in the last 7 days to compare patterns.",
    };
  }

  const sourceTrack = nowPlayingTrack ?? recentTracks[0];
  const sourceCopy = nowPlayingTrack
    ? `Your current track, ${sourceTrack.name}, is anchoring the dashboard.`
    : `Nothing is playing right now, so this reflection is using your recent track ${sourceTrack.name}.`;

  return {
    body: `${sourceCopy} Across the latest ${recentTracks.length || 1} tracks, your listening patterns are leaning ${mood.toLowerCase()} without trying to label your personality or emotions.`,
    headline: `${mood} listening`,
    summary: "A local reflection from Spotify listening data",
  };
}

function createObservations(
  recentTracks: DashboardTrack[],
  moods: DashboardMood[],
): DashboardObservation[] {
  if (recentTracks.length === 0) {
    return [
      {
        detail: "There were no recently played tracks available for this selected day.",
        icon: "sunrise",
        positive: true,
        title: "No observations yet",
        trend: "0%",
      },
    ];
  }

  const uniqueArtists = new Set(recentTracks.map((track) => track.artist)).size;
  const topMood = moods.sort((a, b) => b.value - a.value)[0];
  const repeatedArtists = recentTracks.length - uniqueArtists;

  return [
    {
      detail: `${uniqueArtists} artists appear in your latest ${recentTracks.length} recently played tracks.`,
      icon: "sunrise",
      positive: true,
      title: "Artist variety is visible",
      trend: `+${Math.min(uniqueArtists, 99)}%`,
    },
    {
      detail: `${topMood.label} tracks are the strongest pattern in this Spotify snapshot.`,
      icon: "activity",
      positive: true,
      title: "A dominant mood emerged",
      trend: `+${topMood.value}%`,
    },
    {
      detail:
        repeatedArtists > 0
          ? `${repeatedArtists} recent plays revisit artists already in this sample.`
          : "Your recent sample does not repeat an artist yet.",
      icon: "waves",
      positive: repeatedArtists === 0,
      title: repeatedArtists > 0 ? "Familiar artists returned" : "No artist repeats yet",
      trend: repeatedArtists > 0 ? `+${repeatedArtists}` : "0",
    },
  ];
}

function createTrendData(
  items: SpotifyRecentlyPlayedItem[],
  rangeStart: Date,
  rangeEnd: Date,
): DashboardTrend[] {
  const buckets = buildTrendBuckets(rangeStart, rangeEnd);
  const moodMaps = Array.from({ length: buckets.length }, () => new Map<MoodName, number>());

  items.forEach((item) => {
    const playedAt = new Date(item.played_at);
    const bucketIndex = getTrendBucketIndex(playedAt, buckets);

    if (bucketIndex === -1) {
      return;
    }

    const mood = inferMood(toDashboardTrack(item.track, { playedAt: item.played_at }));
    buckets[bucketIndex].plays += 1;
    moodMaps[bucketIndex].set(mood, (moodMaps[bucketIndex].get(mood) ?? 0) + 1);
  });

  const maxCount = Math.max(...buckets.map((bucket) => bucket.plays), 1);
  return buckets.map((bucket, index) => {
    const dominantMood =
      [...moodMaps[index].entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Quiet";
    const height =
      bucket.plays === 0
        ? "0.35rem"
        : `${Math.max(14, Math.round((bucket.plays / maxCount) * 86))}%`;

    return {
      day: bucket.label,
      dateKey: bucket.dateKey,
      height,
      mood: String(dominantMood).slice(0, 5),
      plays: bucket.plays,
    };
  });
}

function buildTrendBuckets(rangeStart: Date, rangeEnd: Date) {
  const buckets: Array<{ dateKey: string; label: string; plays: number; start: Date; end: Date }> = [];
  const cursor = startOfDay(rangeStart);

  while (cursor.getTime() <= rangeEnd.getTime()) {
    const bucketStart = new Date(cursor);
    buckets.push({
      dateKey: toDateKey(bucketStart),
      end: endOfDay(bucketStart),
      label: formatDayLabel(bucketStart, rangeStart, rangeEnd),
      plays: 0,
      start: bucketStart,
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  return buckets;
}

function getTrendBucketIndex(
  playedAt: Date,
  buckets: Array<{ start: Date; end: Date }>,
) {
  return buckets.findIndex(
    (bucket) => playedAt.getTime() >= bucket.start.getTime() && playedAt.getTime() <= bucket.end.getTime(),
  );
}

function formatRangeLabel(rangeStart: Date, rangeEnd: Date) {
  const diffDays = Math.max(1, Math.round((endOfDay(rangeEnd).getTime() - startOfDay(rangeStart).getTime()) / 86_400_000) + 1);

  if (diffDays <= 7) {
    return "range";
  }

  if (diffDays <= 31) {
    return "window";
  }

  return "period";
}

function formatDayLabel(date: Date, rangeStart: Date, rangeEnd: Date) {
  const diffDays = Math.round((endOfDay(rangeEnd).getTime() - startOfDay(rangeStart).getTime()) / 86_400_000) + 1;

  if (diffDays <= 7) {
    return dayLabels[date.getDay()];
  }

  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
  }).format(date);
}

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function endOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(23, 59, 59, 999);
  return next;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function getDefaultRangeStart() {
  return addDays(startOfDay(new Date()), -6);
}

function toDateKey(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}
