"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Brain,
  Circle,
  Clock3,
  Headphones,
  HeartPulse,
  LogOut,
  Moon,
  Pause,
  RefreshCw,
  Sparkles,
  Sunrise,
  Waves,
} from "lucide-react";
import { SpotifyApiService } from "@/lib/spotify/SpotifyApiService";
import { SpotifyAuthService } from "@/lib/spotify/SpotifyAuthService";
import { createDashboardData } from "@/lib/spotify/dashboardTransform";
import type {
  DashboardData,
  DashboardObservation,
  SpotifyCurrentlyPlaying,
  SpotifyRecentlyPlayedItem,
  SpotifyUserProfile,
} from "@/lib/spotify/types";

const emptyDashboard = createDashboardData({
  currentlyPlaying: null,
  recentlyPlayed: [],
});
const NOW_PLAYING_POLL_MS = 10_000;
const RECENTLY_PLAYED_POLL_MS = 30_000;
const AI_REFRESH_MS = 90_000;

type AuthState = "checking" | "disconnected" | "loading" | "connected" | "error";
type ReflectionNotice = {
  code: string;
  message: string;
};
type RangeSelection = {
  end: Date;
  includesToday: boolean;
  key: string;
  label: string;
  start: Date;
};
type DaySelection = {
  dateKey: string;
  end: Date;
  isToday: boolean;
  label: string;
  shortLabel: string;
  start: Date;
};

const observationIcons = {
  activity: Activity,
  sunrise: Sunrise,
  waves: Waves,
};

function classNames(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export default function Home() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [dashboard, setDashboard] = useState<DashboardData>(emptyDashboard);
  const [errorMessage, setErrorMessage] = useState("");
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  const [isConfigured, setIsConfigured] = useState(false);
  const [selectedDayKey, setSelectedDayKey] = useState(() => toDateKey(new Date()));
  const [reflectionNotice, setReflectionNotice] = useState<ReflectionNotice | null>(null);
  const authStateRef = useRef<AuthState>("checking");
  const currentlyPlayingRef = useRef<SpotifyCurrentlyPlaying | null>(null);
  const profileRef = useRef<SpotifyUserProfile | undefined>(undefined);
  const recentTracksRef = useRef<SpotifyRecentlyPlayedItem[]>([]);
  const syncInFlightRef = useRef(false);
  const lastRecentSyncAtRef = useRef(0);
  const lastReflectionAtRef = useRef(0);
  const lastReflectionSignatureRef = useRef("");

  const isBusy = authState === "checking" || authState === "loading";
  const isConnected = authState === "connected";
  const selectedRange = useMemo(() => buildLastSevenDaysRange(), []);
  const dayOptions = useMemo(() => buildDayOptions(selectedRange), [selectedRange]);
  const selectedDay = useMemo(
    () => getSelectedDay(dayOptions, selectedDayKey),
    [dayOptions, selectedDayKey],
  );

  useEffect(() => {
    authStateRef.current = authState;
  }, [authState]);

  const syncSpotify = useCallback(
    async ({
      forceFullSync = false,
      refreshReflection = false,
      showLoading = false,
    }: {
      forceFullSync?: boolean;
      refreshReflection?: boolean;
      showLoading?: boolean;
    } = {}) => {
      if (syncInFlightRef.current) {
        return;
      }

      syncInFlightRef.current = true;

      try {
        const accessToken = await SpotifyAuthService.getValidToken();
        if (!accessToken) {
          profileRef.current = undefined;
          setDashboard(emptyDashboard);
          setReflectionNotice(null);
          setAuthState("disconnected");
          return;
        }

        if (showLoading) {
          setAuthState("loading");
        }

        const now = Date.now();
        const requestedEndMs = Math.min(selectedRange.end.getTime(), now);
        const selectedRangeDays = Math.max(
          1,
          Math.ceil((requestedEndMs - selectedRange.start.getTime()) / 86_400_000),
        );
        const cachedRangeItems = filterRecentlyPlayedItemsForRange(
          recentTracksRef.current,
          selectedRange.start.getTime(),
          requestedEndMs,
        );
        const cacheCoversRange = cachedRangeItems.length > 0 && rangeStartsBeforeOldestItem(
          cachedRangeItems,
          selectedRange.start.getTime(),
        );
        const shouldRefreshRecent =
          recentTracksRef.current.length === 0 ||
          (forceFullSync && !cacheCoversRange) ||
          (selectedRange.includesToday && now - lastRecentSyncAtRef.current >= RECENTLY_PLAYED_POLL_MS);
        const profilePromise = profileRef.current
          ? Promise.resolve(profileRef.current)
          : SpotifyApiService.getUserProfile(accessToken);
        const currentlyPlayingPromise = SpotifyApiService.getCurrentlyPlaying(accessToken);
        const recentlyPlayedPromise = shouldRefreshRecent
          ? SpotifyApiService.getRecentlyPlayedRange(accessToken, {
              endMs: requestedEndMs,
              maxPages: selectedRangeDays <= 7 ? 3 : 6,
              startMs: selectedRange.start.getTime(),
            })
          : Promise.resolve({ items: cachedRangeItems });

        const [profile, currentlyPlaying, recentlyPlayed] = await Promise.all([
          profilePromise,
          currentlyPlayingPromise,
          recentlyPlayedPromise,
        ]);

        currentlyPlayingRef.current = currentlyPlaying;
        profileRef.current = profile;
        if (shouldRefreshRecent) {
          recentTracksRef.current = recentlyPlayed.items;
          lastRecentSyncAtRef.current = now;
        }

        const analytics = buildAnalyticsSnapshot({
          currentlyPlaying,
          profile,
          recentlyPlayed: recentTracksRef.current,
          selectedDay,
          selectedRange,
        });

        setHistoryNotice(createHistoryNotice(analytics.filteredRecentlyPlayed, selectedDay));
        setDashboard((currentDashboard) => ({
          ...analytics.localDashboard,
          reflection:
            currentDashboard.reflection.headline !== emptyDashboard.reflection.headline
              ? currentDashboard.reflection
              : analytics.localDashboard.reflection,
        }));
        setAuthState("connected");
        const reflectionSignature = createReflectionSignature(analytics.snapshotForReflection);
        const shouldRefreshAI =
          refreshReflection ||
          !lastReflectionSignatureRef.current ||
          reflectionSignature !== lastReflectionSignatureRef.current ||
          now - lastReflectionAtRef.current >= AI_REFRESH_MS;

        if (!shouldRefreshAI) {
          return;
        }

        const reflectionResult = await createOpenAIDashboard(analytics.snapshotForReflection);
        lastReflectionAtRef.current = Date.now();
        lastReflectionSignatureRef.current = reflectionSignature;
        setDashboard(reflectionResult.dashboard);
        setReflectionNotice(reflectionResult.notice);
      } catch (error) {
        if (showLoading || authStateRef.current !== "connected") {
          setAuthState("error");
          setErrorMessage(getErrorMessage(error));
          return;
        }

        setHistoryNotice(
          "Spotify data for that range could not refresh just now, so this view is still showing your latest available snapshot.",
        );
        setAuthState("connected");
      } finally {
        syncInFlightRef.current = false;
      }
    },
    [selectedDay, selectedRange],
  );

  useEffect(() => {
    let isCancelled = false;

    async function boot() {
      if (SpotifyAuthService.ensurePreferredLocalOrigin()) {
        return;
      }

      setIsConfigured(SpotifyAuthService.isConfigured());

      try {
        await SpotifyAuthService.completeRedirectIfNeeded();

        const accessToken = await SpotifyAuthService.getValidToken();
        if (!accessToken) {
          if (!isCancelled) {
            setAuthState("disconnected");
            setDashboard(emptyDashboard);
            setReflectionNotice(null);
          }
          return;
        }

        if (!isCancelled) {
          await syncSpotify({ forceFullSync: true, refreshReflection: true, showLoading: true });
        }
      } catch (error) {
        if (!isCancelled) {
          setAuthState("error");
          setErrorMessage(getErrorMessage(error));
        }
      }
    }

    boot();

    return () => {
      isCancelled = true;
    };
  }, [syncSpotify]);

  useEffect(() => {
    if (!isConnected) {
      return;
    }

    const analytics = buildAnalyticsSnapshot({
      currentlyPlaying: currentlyPlayingRef.current,
      profile: profileRef.current,
      recentlyPlayed: recentTracksRef.current,
      selectedDay,
      selectedRange,
    });

    setHistoryNotice(createHistoryNotice(analytics.filteredRecentlyPlayed, selectedDay));
    setDashboard((currentDashboard) => ({
      ...analytics.localDashboard,
      reflection:
        currentDashboard.reflection.headline !== emptyDashboard.reflection.headline
          ? currentDashboard.reflection
          : analytics.localDashboard.reflection,
    }));

    if (recentTracksRef.current.length > 0) {
      void syncSpotify({ refreshReflection: true });
    }
  }, [isConnected, selectedDay, selectedRange, syncSpotify]);

  useEffect(() => {
    if (!isConnected) {
      return;
    }

    const poll = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      void syncSpotify();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void syncSpotify({ forceFullSync: true });
      }
    };
    const handleFocus = () => {
      void syncSpotify({ forceFullSync: true });
    };

    const pollId = window.setInterval(poll, NOW_PLAYING_POLL_MS);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);

    return () => {
      window.clearInterval(pollId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
    };
  }, [isConnected, syncSpotify]);

  const activeNowPlayingTrackId = dashboard.nowPlaying.track?.id;

  useEffect(() => {
    if (!dashboard.nowPlaying.isPlaying || !activeNowPlayingTrackId) {
      return;
    }

    const progressId = window.setInterval(() => {
      setDashboard((currentDashboard) => advanceNowPlayingProgress(currentDashboard));
    }, 1000);

    return () => {
      window.clearInterval(progressId);
    };
  }, [activeNowPlayingTrackId, dashboard.nowPlaying.isPlaying]);

  async function handleConnect() {
    setErrorMessage("");

    try {
      await SpotifyAuthService.connect();
    } catch (error) {
      setAuthState("error");
      setErrorMessage(getErrorMessage(error));
    }
  }

  function handleDisconnect() {
    SpotifyAuthService.disconnect();
    profileRef.current = undefined;
    recentTracksRef.current = [];
    lastRecentSyncAtRef.current = 0;
    lastReflectionAtRef.current = 0;
    lastReflectionSignatureRef.current = "";
    setDashboard(emptyDashboard);
    setHistoryNotice(null);
    setReflectionNotice(null);
    setAuthState("disconnected");
    setErrorMessage("");
  }

  async function handleRefresh() {
    setErrorMessage("");

    try {
      await syncSpotify({ forceFullSync: true, refreshReflection: true, showLoading: true });
    } catch (error) {
      setAuthState("error");
      setErrorMessage(getErrorMessage(error));
    }
  }

  if (!isConnected) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-4 pb-8 pt-5 text-white sm:px-6 lg:px-8">
        <ConnectionLanding
          authState={authState}
          errorMessage={errorMessage}
          isBusy={isBusy}
          isConfigured={isConfigured}
          onConnect={handleConnect}
        />
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-4 pb-8 pt-5 text-white sm:px-6 lg:px-8">
      <Header
        isBusy={isBusy}
        onDisconnect={handleDisconnect}
        onRefresh={handleRefresh}
        profileName={dashboard.profile?.display_name ?? dashboard.profile?.id}
      />

      <AnalyticsControls
        dayOptions={dayOptions}
        isBusy={isBusy}
        onDaySelect={setSelectedDayKey}
        selectedDayKey={selectedDay.dateKey}
      />

      {reflectionNotice && <StatusBanner message={reflectionNotice.message} />}
      {historyNotice && <StatusBanner message={historyNotice} tone="cool" />}

      <section className="mt-6 grid gap-4 lg:grid-cols-[1.08fr_0.92fr]">
        <CurrentMoodCard dashboard={dashboard} />
        <NowPlayingCard dashboard={dashboard} isConnected={isConnected} isBusy={isBusy} />
      </section>

      <section className="mt-4 grid gap-4 lg:grid-cols-[0.92fr_1.08fr]">
        <MoodBreakdown dashboard={dashboard} rangeLabel={selectedDay.label} />
        <WeeklyTrend dashboard={dashboard} rangeLabel={selectedRange.label} selectedDayKey={selectedDay.dateKey} />
      </section>

      <section className="mt-4 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <AIReflection dashboard={dashboard} rangeLabel={selectedDay.label} />
        <InterestingObservations observations={dashboard.observations} />
      </section>
    </main>
  );
}

function ConnectionLanding({
  authState,
  errorMessage,
  isBusy,
  isConfigured,
  onConnect,
}: {
  authState: AuthState;
  errorMessage: string;
  isBusy: boolean;
  isConfigured: boolean;
  onConnect: () => void;
}) {
  const buttonLabel =
    authState === "checking"
      ? "Checking connection"
      : authState === "loading"
        ? "Syncing Spotify"
        : "Link Spotify account";

  return (
    <section className="flex min-h-[calc(100vh-3.25rem)] flex-col">
      <div className="flex items-center gap-2 text-sm font-medium text-[#9da7b7]">
        <span className="grid size-7 place-items-center rounded-full bg-[#f7f8fb] text-[#08090d]">
          <Headphones size={15} strokeWidth={2.4} />
        </span>
        Music Mirror
      </div>

      <div className="flex flex-1 items-center py-8">
        <div className="w-full">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[#4ecdc4]">
              Listening health starts here
            </p>
            <h1 className="mt-4 text-5xl font-semibold leading-[0.9] tracking-normal sm:text-7xl">
              Link Spotify to see your mirror.
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-[#aeb7c6] sm:text-lg">
              Connect your Spotify account to turn currently playing and recently played tracks
              into mood patterns, weekly trends, and listening reflections.
            </p>
          </div>

          <div className="mt-8 grid gap-4 lg:grid-cols-[1fr_0.78fr]">
            <div className="min-w-0 rounded-[28px] border border-white/10 bg-[#151922]/90 p-5 shadow-[0_18px_70px_rgba(0,0,0,0.32)]">
              <button
                className="flex w-full items-center justify-between gap-4 rounded-[24px] bg-[#f7f8fb] px-5 py-5 text-left text-[#08090d] shadow-[0_18px_55px_rgba(247,248,251,0.16)] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!isConfigured || isBusy}
                onClick={onConnect}
                type="button"
              >
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-[#59606b]">
                    Spotify connection
                  </span>
                  <span className="mt-1 block text-2xl font-semibold leading-tight">
                    {buttonLabel}
                  </span>
                </span>
                <span className="grid size-12 shrink-0 place-items-center rounded-full bg-[#08090d] text-white">
                  <ArrowUpRight size={22} />
                </span>
              </button>

              {(errorMessage || !isConfigured) && (
                <StatusBanner
                  message={
                    errorMessage ||
                    "Spotify connection is not available yet. Please check back soon."
                  }
                />
              )}
            </div>

            <div className="min-w-0 rounded-[28px] border border-[#4ecdc4]/20 bg-[#101b1f]/90 p-5">
              <div className="flex items-center gap-3">
                <span className="grid size-11 place-items-center rounded-2xl bg-[#4ecdc4]/14 text-[#4ecdc4]">
                  <HeartPulse size={22} />
                </span>
                <div>
                  <p className="text-sm font-medium text-[#9da7b7]">After linking</p>
                  <h2 className="text-2xl font-semibold">Your dashboard appears</h2>
                </div>
              </div>

              <div className="mt-5 space-y-3 text-sm leading-6 text-[#c9d0dc]">
                <p>Current listening mood</p>
                <p>Now playing and recently played tracks</p>
                <p>Weekly trends and reflection cards</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Header({
  isBusy,
  onDisconnect,
  onRefresh,
  profileName,
}: {
  isBusy: boolean;
  onDisconnect: () => void;
  onRefresh: () => void;
  profileName?: string | null;
}) {
  const today = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        day: "numeric",
        month: "short",
      }).format(new Date()),
    [],
  );

  return (
    <header className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium text-[#9da7b7]">
          <span className="grid size-7 place-items-center rounded-full bg-[#f7f8fb] text-[#08090d]">
            <Headphones size={15} strokeWidth={2.4} />
          </span>
          <span className="truncate">Music Mirror</span>
        </div>
        <h1 className="mt-4 max-w-[11ch] text-5xl font-semibold leading-[0.9] tracking-normal sm:max-w-none sm:text-6xl">
          Listening Health
        </h1>
        <p className="mt-3 text-sm text-[#9da7b7]">
          {`Connected${profileName ? ` as ${profileName}` : ""}`}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-2">
        <div className="min-w-[4.5rem] rounded-full border border-white/10 bg-white/[0.06] px-3 py-2 text-right shadow-[0_12px_40px_rgba(0,0,0,0.28)] backdrop-blur">
          <p className="text-xs text-[#9da7b7]">Today</p>
          <p className="text-sm font-semibold">{today}</p>
        </div>

        <div className="flex gap-2">
          <IconButton
            disabled={isBusy}
            label="Refresh Spotify data"
            onClick={onRefresh}
            title="Refresh"
          >
            <RefreshCw size={16} className={isBusy ? "animate-spin" : ""} />
          </IconButton>
          <IconButton label="Disconnect Spotify" onClick={onDisconnect} title="Disconnect">
            <LogOut size={16} />
          </IconButton>
        </div>
      </div>
    </header>
  );
}

function StatusBanner({
  message,
  tone = "warm",
}: {
  message: string;
  tone?: "cool" | "warm";
}) {
  return (
    <div
      className={classNames(
        "mt-5 break-words rounded-[24px] px-4 py-3 text-sm leading-6",
        tone === "warm"
          ? "border border-[#ffcd56]/20 bg-[#ffcd56]/10 text-[#ffe7a3]"
          : "border border-[#4ecdc4]/20 bg-[#4ecdc4]/10 text-[#c9f7f2]",
      )}
    >
      {message}
    </div>
  );
}

function AnalyticsControls({
  dayOptions,
  isBusy,
  onDaySelect,
  selectedDayKey,
}: {
  dayOptions: DaySelection[];
  isBusy: boolean;
  onDaySelect: (value: string) => void;
  selectedDayKey: string;
}) {
  return (
    <section className="mt-4 rounded-[28px] border border-white/10 bg-[#11141c]/90 p-4 shadow-[0_18px_70px_rgba(0,0,0,0.24)]">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium text-[#9da7b7]">Listening analysis</p>
            <h2 className="mt-1 text-2xl font-semibold">Choose a day from the last 7 days</h2>
          </div>
          <p className="text-sm text-[#768092]">The rest of the dashboard follows this selection.</p>
        </div>

        <div className="-mx-1 overflow-x-auto px-1 pb-1 md:mx-0 md:overflow-visible md:px-0">
          <div className="flex min-w-max gap-2 md:min-w-0 md:grid md:grid-cols-7">
            {dayOptions.map((option) => (
              <button
                key={option.dateKey}
                className={classNames(
                  "min-h-[3.65rem] min-w-[5.25rem] rounded-[18px] border px-3 py-2 text-left transition md:min-w-0 md:w-full",
                  selectedDayKey === option.dateKey
                    ? "border-[#4ecdc4]/35 bg-[linear-gradient(180deg,rgba(78,205,196,0.18),rgba(78,205,196,0.08))] text-[#f7f8fb]"
                    : "border-white/10 bg-[#0c0f15] text-[#9da7b7]",
                )}
                disabled={isBusy}
                onClick={() => onDaySelect(option.dateKey)}
                type="button"
              >
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em]">{option.shortLabel}</p>
                <p className="mt-1 text-sm font-semibold">{option.label}</p>
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function CurrentMoodCard({ dashboard }: { dashboard: DashboardData }) {
  const hasListeningData =
    dashboard.recentTracks.length > 0 || Boolean(dashboard.nowPlaying.track);

  return (
    <article className="min-w-0 overflow-hidden rounded-[28px] border border-white/10 bg-[#151922]/90 p-5 shadow-[0_18px_70px_rgba(0,0,0,0.32)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-[#9da7b7]">Current Listening Mood</p>
          <h2 className="mt-2 text-4xl font-semibold tracking-normal">
            {hasListeningData ? dashboard.currentMood.label : "No data"}
          </h2>
        </div>
        <span className="grid size-12 place-items-center rounded-2xl bg-[#4ecdc4]/15 text-[#4ecdc4]">
          <Moon size={24} strokeWidth={2.2} />
        </span>
      </div>

      <div className="mt-7 flex flex-col gap-5 sm:flex-row sm:items-end sm:gap-4">
        <div className="relative grid size-40 shrink-0 place-items-center self-center rounded-full bg-[conic-gradient(#4ecdc4_0deg_132deg,#8ba5ff_132deg_222deg,#ffcd56_222deg_286deg,#c7f36c_286deg_336deg,#ff7a5c_336deg_360deg)] p-3 sm:size-36">
          <div className="grid size-full place-items-center rounded-full bg-[#151922]">
            <div className="text-center">
              <p className="text-4xl font-semibold">{hasListeningData ? dashboard.currentMood.score : "--"}</p>
              <p className="text-xs uppercase tracking-[0.2em] text-[#9da7b7]">
                {hasListeningData ? "Balance" : "Waiting"}
              </p>
            </div>
          </div>
        </div>
        <div className="min-w-0 pb-2">
          <p className="text-sm leading-6 text-[#c9d0dc]">
            {dashboard.currentMood.description}
          </p>
          {hasListeningData ? (
            <div className="mt-4 flex flex-wrap gap-2">
              <MetricPill icon={ArrowUpRight} label={dashboard.currentMood.trendLabel} />
              <MetricPill icon={Clock3} label={dashboard.currentMood.timeListenedToday} />
            </div>
          ) : (
            <p className="mt-4 text-sm text-[#9da7b7]">
              Play music on Spotify and this card will populate.
            </p>
          )}

          <div className="mt-5 rounded-[20px] border border-white/10 bg-[#0c0f15] px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#768092]">
                Theme signal
              </p>
              <span className="text-xs font-semibold text-[#9da7b7]">
                {dashboard.themeSignal.label ? `${dashboard.themeSignal.strength}%` : "No data"}
              </span>
            </div>
            <p className="mt-2 text-base font-semibold text-[#f7f8fb]">
              {dashboard.themeSignal.label ?? "No clear theme"}
            </p>
            <p className="mt-1 text-sm leading-6 text-[#9da7b7]">
              {dashboard.themeSignal.description}
            </p>
          </div>
        </div>
      </div>
    </article>
  );
}

function NowPlayingCard({
  dashboard,
  isBusy,
  isConnected,
}: {
  dashboard: DashboardData;
  isBusy: boolean;
  isConnected: boolean;
}) {
  const track = dashboard.nowPlaying.track;
  const hasTrack = Boolean(track);

  return (
    <article className="min-w-0 rounded-[28px] border border-white/10 bg-[#11141c]/90 p-5 shadow-[0_18px_70px_rgba(0,0,0,0.28)]">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-[#9da7b7]">Now Playing</p>
        <span
          className={classNames(
            "flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold",
            dashboard.nowPlaying.isPlaying
              ? "bg-[#c7f36c]/12 text-[#c7f36c]"
              : "bg-white/[0.07] text-[#9da7b7]",
          )}
        >
          <Circle size={7} fill="currentColor" strokeWidth={0} />
          {dashboard.nowPlaying.sourceLabel}
        </span>
      </div>

      <div className="mt-5 flex gap-4">
        <div
          className="grid size-24 shrink-0 place-items-center overflow-hidden rounded-[22px] bg-[linear-gradient(135deg,#223047,#4ecdc4_50%,#ffcd56)] bg-cover bg-center shadow-[0_14px_45px_rgba(78,205,196,0.22)]"
          style={track?.albumImageUrl ? { backgroundImage: `url(${track.albumImageUrl})` } : undefined}
        >
          {!track?.albumImageUrl && (
            <Pause size={26} fill="currentColor" strokeWidth={0} className="text-[#081016]" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-2xl font-semibold">
            {track?.name ??
              (isBusy
                ? "Checking Spotify"
                : isConnected
                  ? "Nothing playing right now"
                  : "Spotify not connected")}
          </h2>
          <p className="mt-1 truncate text-sm text-[#9da7b7]">
            {track?.artist ??
              (isConnected
                ? "Recent tracks are still used for the reflections below"
                : "Connect to fetch your listening data")}
          </p>
          <div className="mt-5">
            <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-[#4ecdc4]"
                style={{ width: `${dashboard.nowPlaying.progressPercent}%` }}
              />
            </div>
            <div className="mt-2 flex justify-between text-xs text-[#9da7b7]">
              <span>{dashboard.nowPlaying.progressLabel}</span>
              <span>{dashboard.nowPlaying.durationLabel}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-3 gap-2">
        <MiniStat label="Mood" value={hasTrack ? dashboard.nowPlaying.mood : "Idle"} />
        <MiniStat label="Tempo" value={hasTrack ? dashboard.nowPlaying.tempo : "-"} />
        <MiniStat label="Energy" value={hasTrack ? dashboard.nowPlaying.energy : "-"} />
      </div>
    </article>
  );
}

function MoodBreakdown({ dashboard, rangeLabel }: { dashboard: DashboardData; rangeLabel: string }) {
  const hasListeningData =
    dashboard.recentTracks.length > 0 || Boolean(dashboard.nowPlaying.track);

  return (
    <article className="min-w-0 rounded-[28px] border border-white/10 bg-[#11141c]/90 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-[#9da7b7]">Mood Breakdown</p>
          <h2 className="mt-1 text-2xl font-semibold">{rangeLabel}</h2>
        </div>
        <HeartPulse className="text-[#ff7a5c]" size={24} />
      </div>

      {hasListeningData ? (
        <div className="mt-6 space-y-4">
          {dashboard.moodBreakdown.map((mood) => (
            <div key={mood.label}>
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium text-[#e9edf5]">{mood.label}</span>
                <span className="text-[#9da7b7]">{mood.value}%</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                <div
                  className={classNames("h-full rounded-full", mood.color)}
                  style={{ width: `${mood.value}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-6 text-sm leading-6 text-[#9da7b7]">
          No listening data is available for this day yet.
        </p>
      )}
    </article>
  );
}

function WeeklyTrend({
  dashboard,
  rangeLabel,
  selectedDayKey,
}: {
  dashboard: DashboardData;
  rangeLabel: string;
  selectedDayKey: string;
}) {
  return (
    <article className="min-w-0 rounded-[28px] border border-white/10 bg-[#151922]/90 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-[#9da7b7]">Listening Trend</p>
          <h2 className="mt-1 text-2xl font-semibold">
            {dashboard.recentTracks.length > 0 ? rangeLabel : "Waiting for history"}
          </h2>
        </div>
        <MetricPill icon={ArrowUpRight} label="7-day view" />
      </div>

      <div className="mt-6 overflow-x-auto rounded-[24px] bg-[#0c0f15] px-3 py-4">
        <div
          className="grid h-56 min-w-full grid-flow-col auto-cols-[minmax(2rem,1fr)] items-end gap-2"
          style={{ minWidth: `${Math.max(dashboard.weeklyTrend.length * 2.2, 100)}%` }}
        >
        {dashboard.weeklyTrend.map((item, index) => (
          <div key={`${item.day}-${index}`} className="flex h-full min-w-0 flex-col justify-end gap-2">
            <div className="flex min-h-0 flex-1 items-end">
              <div
                className={classNames(
                  "w-full rounded-full",
                  item.dateKey === selectedDayKey
                    ? "bg-[linear-gradient(180deg,#ffcd56,#4ecdc4)]"
                    : "bg-[linear-gradient(180deg,#4ecdc4,#8ba5ff)]",
                )}
                style={{ height: item.height }}
              />
            </div>
            <div className="text-center">
              <p className="text-xs font-semibold text-[#f7f8fb]">{item.day}</p>
              <p className="truncate text-[10px] text-[#768092]">{item.plays} plays</p>
            </div>
          </div>
        ))}
        </div>
      </div>
    </article>
  );
}

function AIReflection({ dashboard, rangeLabel }: { dashboard: DashboardData; rangeLabel: string }) {
  return (
    <article className="min-w-0 rounded-[28px] border border-[#4ecdc4]/20 bg-[#101b1f]/90 p-5">
      <div className="flex items-center gap-3">
        <span className="grid size-11 place-items-center rounded-2xl bg-[#4ecdc4]/14 text-[#4ecdc4]">
          <Brain size={23} />
        </span>
        <div>
          <p className="text-sm font-medium text-[#9da7b7]">AI Reflection</p>
          <h2 className="text-2xl font-semibold">{dashboard.reflection.headline}</h2>
        </div>
      </div>

      <p className="mt-5 text-[1.7rem] font-semibold leading-tight tracking-normal text-[#f7f8fb]">
        {renderReflectionText(dashboard.reflection.body, "hero")}
      </p>
      <p className="mt-4 text-sm leading-6 text-[#aeb7c6]">
        {renderReflectionText(`${dashboard.reflection.summary} Based on ${rangeLabel}.`, "summary")}
      </p>
    </article>
  );
}

function renderReflectionText(text: string, variant: "hero" | "summary") {
  const segments = text.split(/(".*?")/g);

  return segments.map((segment, index) => {
    if (segment.startsWith('"') && segment.endsWith('"')) {
      return (
        <span
          key={`${segment}-${index}`}
          className={classNames(
            "font-semibold text-[#7de2da]",
            variant === "hero" ? "drop-shadow-[0_0_18px_rgba(125,226,218,0.12)]" : "",
          )}
        >
          {segment}
        </span>
      );
    }

    return <span key={`${segment}-${index}`}>{segment}</span>;
  });
}

function InterestingObservations({ observations }: { observations: DashboardObservation[] }) {
  return (
    <article className="min-w-0 rounded-[28px] border border-white/10 bg-[#11141c]/90 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-[#9da7b7]">Interesting Observations</p>
          <h2 className="mt-1 text-2xl font-semibold">Patterns found</h2>
        </div>
        <Sparkles className="text-[#ffcd56]" size={24} />
      </div>

      <div className="mt-5 space-y-3">
        {observations.map((item) => {
          const Icon = observationIcons[item.icon];
          return (
            <div key={item.title} className="rounded-[22px] bg-white/[0.055] p-4">
              <div className="flex gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-white/8 text-[#e9edf5]">
                  <Icon size={20} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-col gap-2 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,17rem)] sm:items-start sm:gap-3">
                    <h3 className="min-w-0 text-sm font-semibold text-[#f7f8fb]">{item.title}</h3>
                    <span
                      className={classNames(
                        "flex min-w-0 items-start gap-1 text-sm font-semibold leading-5 sm:justify-self-end sm:text-right",
                        item.positive ? "text-[#c7f36c]" : "text-[#ff9d86]",
                      )}
                    >
                      <span className="mt-0.5 shrink-0">
                        {item.positive ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
                      </span>
                      <span className="min-w-0 break-words">{item.trend}</span>
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-5 text-[#aeb7c6]">{item.detail}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </article>
  );
}

function IconButton({
  children,
  disabled,
  label,
  onClick,
  title,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      aria-label={label}
      className="grid size-10 place-items-center rounded-full border border-white/10 bg-white/[0.07] text-[#e9edf5] disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}

function MetricPill({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.07] px-3 py-1.5 text-xs font-semibold text-[#e9edf5]">
      <Icon size={14} className="text-[#4ecdc4]" />
      {label}
    </span>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-white/[0.055] p-3">
      <p className="text-[11px] text-[#9da7b7]">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold text-[#f7f8fb]">{value}</p>
    </div>
  );
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Something went wrong while connecting Spotify.";
}

async function createOpenAIDashboard(input: Parameters<typeof createDashboardData>[0]) {
  const localDashboard = createDashboardData(input);

  try {
    const response = await fetch("/api/reflection", {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    if (!response.ok) {
      return { dashboard: localDashboard, notice: null };
    }

    const data = (await response.json()) as {
      dashboard?: DashboardData;
      notice?: ReflectionNotice;
    };
    return {
      dashboard: data.dashboard ?? localDashboard,
      notice: data.notice ?? null,
    };
  } catch {
    return { dashboard: localDashboard, notice: null };
  }
}

function createReflectionSignature(input: {
  currentlyPlaying: SpotifyCurrentlyPlaying | null;
  recentlyPlayed: SpotifyRecentlyPlayedItem[];
}) {
  const currentTrack = input.currentlyPlaying?.item;
  const recentKey = input.recentlyPlayed
    .slice(0, 5)
    .map((item) => `${item.track.id}:${item.played_at}`)
    .join("|");

  return [
    currentTrack?.id ?? "none",
    input.currentlyPlaying?.is_playing ? "playing" : "paused",
    recentKey,
  ].join("::");
}

function buildLastSevenDaysRange(): RangeSelection {
  const today = new Date();
  const end = endOfDay(today);
  const start = startOfDay(addDays(today, -6));

  return {
    end,
    includesToday: true,
    key: `7d:${start.toISOString()}:${end.toISOString()}`,
    label: "Last 7 days",
    start,
  };
}

function createHistoryNotice(items: SpotifyRecentlyPlayedItem[], selectedDay: DaySelection) {
  if (items.length === 0) {
    return `No listening history was available for ${selectedDay.label} yet.`;
  }

  const oldestItem = items[items.length - 1];
  if (!oldestItem) {
    return null;
  }

  const oldestMs = new Date(oldestItem.played_at).getTime();
  if (oldestMs > selectedDay.start.getTime()) {
    return `This reflection is based on the available Spotify history inside ${selectedDay.label}.`;
  }

  return null;
}

function buildDayOptions(range: RangeSelection): DaySelection[] {
  const options: DaySelection[] = [];
  const todayKey = toDateKey(new Date());
  const cursor = startOfDay(range.start);

  while (cursor.getTime() <= range.end.getTime()) {
    const date = new Date(cursor);
    const dateKey = toDateKey(date);
    options.push({
      dateKey,
      end: endOfDay(date),
      isToday: dateKey === todayKey,
      label: getRelativeDayLabel(date),
      shortLabel: new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date),
      start: startOfDay(date),
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  return options.reverse();
}

function getSelectedDay(options: DaySelection[], selectedDayKey: string) {
  return options.find((option) => option.dateKey === selectedDayKey) ?? options[0];
}

function buildAnalyticsSnapshot({
  currentlyPlaying,
  profile,
  recentlyPlayed,
  selectedDay,
  selectedRange,
}: {
  currentlyPlaying: SpotifyCurrentlyPlaying | null;
  profile?: SpotifyUserProfile;
  recentlyPlayed: SpotifyRecentlyPlayedItem[];
  selectedDay: DaySelection;
  selectedRange: RangeSelection;
}) {
  const filteredRecentlyPlayed = filterRecentlyPlayedItemsForRange(
    recentlyPlayed,
    selectedDay.start.getTime(),
    selectedDay.end.getTime(),
  );
  const trendRecentlyPlayed = filterRecentlyPlayedItemsForRange(
    recentlyPlayed,
    selectedRange.start.getTime(),
    selectedRange.end.getTime(),
  );
  const snapshotForReflection = {
    currentlyPlaying: selectedDay.isToday ? currentlyPlaying : null,
    profile,
    rangeEnd: selectedDay.end,
    rangeStart: selectedDay.start,
    recentlyPlayed: filteredRecentlyPlayed,
    trendRecentlyPlayed,
  };

  return {
    filteredRecentlyPlayed,
    localDashboard: createDashboardData({
      ...snapshotForReflection,
      rangeEnd: selectedDay.end,
      rangeStart: selectedDay.start,
      trendRecentlyPlayed,
    }),
    snapshotForReflection,
  };
}

function filterRecentlyPlayedItemsForRange(
  items: SpotifyRecentlyPlayedItem[],
  startMs: number,
  endMs: number,
) {
  return items.filter((item) => {
    const playedAtMs = new Date(item.played_at).getTime();
    return playedAtMs >= startMs && playedAtMs <= endMs;
  });
}

function rangeStartsBeforeOldestItem(items: SpotifyRecentlyPlayedItem[], startMs: number) {
  if (items.length === 0) {
    return false;
  }

  const oldestMs = Math.min(...items.map((item) => new Date(item.played_at).getTime()));
  return oldestMs <= startMs;
}

function advanceNowPlayingProgress(currentDashboard: DashboardData) {
  const track = currentDashboard.nowPlaying.track;

  if (!currentDashboard.nowPlaying.isPlaying || !track) {
    return currentDashboard;
  }

  const currentProgress = track.progressMs ?? 0;
  const nextProgress = Math.min(track.durationMs, currentProgress + 1000);

  if (nextProgress === currentProgress) {
    return currentDashboard;
  }

  const nextTrack = { ...track, progressMs: nextProgress };
  return {
    ...currentDashboard,
    nowPlaying: {
      ...currentDashboard.nowPlaying,
      durationLabel: formatProgressDuration(track.durationMs),
      progressLabel: formatProgressDuration(nextProgress),
      progressPercent: Math.max(0, Math.min(100, Math.round((nextProgress / track.durationMs) * 100))),
      track: nextTrack,
    },
  };
}

function formatProgressDuration(milliseconds: number) {
  if (!milliseconds) {
    return "0:00";
  }

  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
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

function getRelativeDayLabel(date: Date) {
  const today = startOfDay(new Date());
  const target = startOfDay(date);
  const diffDays = Math.round((today.getTime() - target.getTime()) / 86_400_000);

  if (diffDays === 0) {
    return "Today";
  }

  if (diffDays === 1) {
    return "Yesterday";
  }

  if (diffDays === 2) {
    return "2 days ago";
  }

  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
  }).format(date);
}

function toDateKey(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}
