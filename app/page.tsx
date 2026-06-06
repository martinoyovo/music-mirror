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
import {
  createEnergyArcData,
  type EnergyArcStatus,
} from "@/lib/spotify/energyArc";
import { SpotifyApiService } from "@/lib/spotify/SpotifyApiService";
import { SpotifyAuthService } from "@/lib/spotify/SpotifyAuthService";
import { createDashboardData } from "@/lib/spotify/dashboardTransform";
import type {
  DashboardData,
  DashboardObservation,
  SpotifyTrackAudioAnalysis,
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
type TrackAnalysisState = {
  analysis: SpotifyTrackAudioAnalysis | null;
  status: EnergyArcStatus;
  trackId?: string;
};
type TodayWindow = {
  end: Date;
  label: string;
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
  const [dataNotice, setDataNotice] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [isConfigured, setIsConfigured] = useState(false);
  const [reflectionNotice, setReflectionNotice] = useState<ReflectionNotice | null>(null);
  const [trackAnalysis, setTrackAnalysis] = useState<TrackAnalysisState>({
    analysis: null,
    status: "idle",
  });
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
  const todayWindow = useMemo(() => buildTodayWindow(), []);
  const energyArc = useMemo(
    () =>
      createEnergyArcData({
        analysis:
          trackAnalysis.trackId === dashboard.nowPlaying.track?.id ? trackAnalysis.analysis : null,
        isPlaying: dashboard.nowPlaying.isPlaying,
        status:
          trackAnalysis.trackId === dashboard.nowPlaying.track?.id
            ? trackAnalysis.status
            : "idle",
        tempoLabel: dashboard.nowPlaying.tempo,
        track: dashboard.nowPlaying.track,
      }),
    [dashboard.nowPlaying.isPlaying, dashboard.nowPlaying.tempo, dashboard.nowPlaying.track, trackAnalysis],
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
        const requestedEndMs = Math.min(todayWindow.end.getTime(), now);
        const cachedTodayItems = filterRecentlyPlayedItemsForRange(
          recentTracksRef.current,
          todayWindow.start.getTime(),
          requestedEndMs,
        );
        const cacheCoversToday = cachedTodayItems.length > 0 && rangeStartsBeforeOldestItem(
          cachedTodayItems,
          todayWindow.start.getTime(),
        );
        const shouldRefreshRecent =
          recentTracksRef.current.length === 0 ||
          (forceFullSync && !cacheCoversToday) ||
          now - lastRecentSyncAtRef.current >= RECENTLY_PLAYED_POLL_MS;
        const profilePromise = profileRef.current
          ? Promise.resolve(profileRef.current)
          : SpotifyApiService.getUserProfile(accessToken);
        const currentlyPlayingPromise = SpotifyApiService.getCurrentlyPlaying(accessToken);
        const recentlyPlayedPromise = shouldRefreshRecent
          ? SpotifyApiService.getRecentlyPlayedRange(accessToken, {
              endMs: requestedEndMs,
              maxPages: 2,
              startMs: todayWindow.start.getTime(),
            })
          : Promise.resolve({ items: cachedTodayItems });

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
          todayWindow,
        });

        setDataNotice(createTodayDataNotice(analytics.filteredRecentlyPlayed));
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

        setDataNotice(
          "Spotify data could not refresh just now, so this view is still showing your latest available sample.",
        );
        setAuthState("connected");
      } finally {
        syncInFlightRef.current = false;
      }
    },
    [todayWindow],
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
      todayWindow,
    });

    setDataNotice(createTodayDataNotice(analytics.filteredRecentlyPlayed));
    setDashboard((currentDashboard) => ({
      ...analytics.localDashboard,
      reflection:
        currentDashboard.reflection.headline !== emptyDashboard.reflection.headline
          ? currentDashboard.reflection
          : analytics.localDashboard.reflection,
    }));
  }, [isConnected, syncSpotify, todayWindow]);

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

  useEffect(() => {
    const activeTrackId = dashboard.nowPlaying.track?.id;

    if (!activeTrackId) {
      setTrackAnalysis({ analysis: null, status: "idle" });
      return;
    }

    const trackId = activeTrackId;

    if (trackAnalysis.trackId === trackId && trackAnalysis.status !== "idle") {
      return;
    }

    let isCancelled = false;
    setTrackAnalysis({ analysis: null, status: "loading", trackId });

    async function loadTrackAnalysis() {
      try {
        const accessToken = await SpotifyAuthService.getValidToken();

        if (!accessToken) {
          if (!isCancelled) {
            setTrackAnalysis({
              analysis: null,
              status: "unavailable",
              trackId,
            });
          }
          return;
        }

        const analysis = await SpotifyApiService.getTrackAudioAnalysis(accessToken, trackId);

        if (isCancelled) {
          return;
        }

        setTrackAnalysis({
          analysis,
          status: analysis?.sections?.length ? "ready" : "unavailable",
          trackId,
        });
      } catch {
        if (!isCancelled) {
          setTrackAnalysis({
            analysis: null,
            status: "unavailable",
            trackId,
          });
        }
      }
    }

    void loadTrackAnalysis();

    return () => {
      isCancelled = true;
    };
  }, [dashboard.nowPlaying.track?.id, trackAnalysis.status, trackAnalysis.trackId]);

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
    setDataNotice(null);
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

      <TodayOverview dashboard={dashboard} />

      {reflectionNotice && <StatusBanner message={reflectionNotice.message} />}
      {dataNotice && <StatusBanner message={dataNotice} tone="cool" />}

      <section className="mt-6 grid gap-4 lg:grid-cols-[1.08fr_0.92fr]">
        <CurrentMoodCard dashboard={dashboard} />
        <NowPlayingCard dashboard={dashboard} isConnected={isConnected} isBusy={isBusy} />
      </section>

      {dashboard.nowPlaying.track && (
        <section className="mt-4">
          <LiveEnergyArcCard energyArc={energyArc} />
        </section>
      )}

      <section className="mt-4">
        <MoodBreakdown dashboard={dashboard} rangeLabel={todayWindow.label} />
      </section>

      <section className="mt-4 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <AIReflection dashboard={dashboard} rangeLabel={todayWindow.label} />
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
              into today&apos;s mood patterns and listening reflections.
            </p>
          </div>

          <div className="mt-8 grid gap-4 lg:grid-cols-[1fr_0.78fr]">
            <div className="motion-card min-w-0 rounded-[28px] border border-white/10 bg-[#151922]/90 p-5 shadow-[0_18px_70px_rgba(0,0,0,0.32)]">
              <button
                className="motion-action flex w-full items-center justify-between gap-4 rounded-[24px] bg-[#f7f8fb] px-5 py-5 text-left text-[#08090d] shadow-[0_18px_55px_rgba(247,248,251,0.16)] disabled:cursor-not-allowed disabled:opacity-50"
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

            <div className="motion-card min-w-0 rounded-[28px] border border-[#4ecdc4]/20 bg-[#101b1f]/90 p-5">
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
                <p>Today&apos;s patterns and AI reflection</p>
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
        "motion-card mt-5 break-words rounded-[24px] px-4 py-3 text-sm leading-6",
        tone === "warm"
          ? "border border-[#ffcd56]/20 bg-[#ffcd56]/10 text-[#ffe7a3]"
          : "border border-[#4ecdc4]/20 bg-[#4ecdc4]/10 text-[#c9f7f2]",
      )}
    >
      {message}
    </div>
  );
}

function TodayOverview({ dashboard }: { dashboard: DashboardData }) {
  const playCount = dashboard.recentTracks.length;
  const artistCount = new Set(dashboard.recentTracks.map((track) => track.artist)).size;
  const activeTrack = dashboard.nowPlaying.track;

  return (
    <section className="motion-card mt-4 rounded-[28px] border border-white/10 bg-[#11141c]/90 p-4 shadow-[0_18px_70px_rgba(0,0,0,0.24)]">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-[#9da7b7]">Listening analysis</p>
          <h2 className="mt-1 text-3xl font-semibold">Today&apos;s listening mirror</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#9da7b7]">
            Built from what Spotify returns right now: current playback and today&apos;s available
            recent plays.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-2 md:min-w-[22rem]">
          <MiniStat label="Available plays" value={String(playCount)} />
          <MiniStat label="Artists" value={String(artistCount)} />
          <MiniStat label="Source" value={activeTrack ? "Live" : "Recent"} />
        </div>
      </div>

      {playCount > 0 || activeTrack ? (
        <div className="mt-4 rounded-[22px] border border-[#4ecdc4]/15 bg-[#4ecdc4]/8 px-4 py-3">
          <p className="text-sm font-medium text-[#c9f7f2]">
            {activeTrack
              ? `"${activeTrack.name}" is anchoring today's view.`
              : "Today's view is using your available recently played tracks."}
          </p>
        </div>
      ) : (
        <div className="mt-4 rounded-[22px] border border-white/10 bg-[#0c0f15] px-4 py-3">
          <p className="text-sm leading-6 text-[#9da7b7]">
            Play something on Spotify and Music Mirror will start reflecting today&apos;s available
            listening sample.
          </p>
        </div>
      )}
    </section>
  );
}

function CurrentMoodCard({ dashboard }: { dashboard: DashboardData }) {
  const hasListeningData =
    dashboard.recentTracks.length > 0 || Boolean(dashboard.nowPlaying.track);

  return (
    <article className="motion-card min-w-0 overflow-hidden rounded-[28px] border border-white/10 bg-[#151922]/90 p-5 shadow-[0_18px_70px_rgba(0,0,0,0.32)]">
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
    <article className="motion-card min-w-0 rounded-[28px] border border-white/10 bg-[#11141c]/90 p-5 shadow-[0_18px_70px_rgba(0,0,0,0.28)]">
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
    <article className="motion-card min-w-0 rounded-[28px] border border-white/10 bg-[#11141c]/90 p-5">
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
          No listening data is available for today yet.
        </p>
      )}
    </article>
  );
}

function LiveEnergyArcCard({
  energyArc,
}: {
  energyArc: ReturnType<typeof createEnergyArcData>;
}) {
  return (
    <article className="motion-card min-w-0 rounded-[28px] border border-white/10 bg-[#11141c]/90 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-[#9da7b7]">Live Energy Arc</p>
          <h2 className="mt-1 text-2xl font-semibold">{energyArc.title}</h2>
        </div>
        <span className="rounded-full bg-white/[0.07] px-3 py-1 text-xs font-semibold text-[#9da7b7]">
          {energyArc.sourceLabel}
        </span>
      </div>

      {energyArc.status === "loading" ? (
        <div className="mt-5 flex items-center gap-3 rounded-[22px] border border-white/8 bg-[#0d1017] px-4 py-4">
          <RefreshCw size={18} className="animate-spin text-[#4ecdc4]" />
          <div>
            <p className="text-sm font-semibold text-[#f7f8fb]">{energyArc.currentLabel}</p>
            <p className="text-sm text-[#9da7b7]">{energyArc.summary}</p>
          </div>
        </div>
      ) : energyArc.status === "unavailable" ? (
        <div className="mt-5 rounded-[22px] border border-white/8 bg-[#0d1017] px-4 py-4">
          <p className="text-sm font-semibold text-[#f7f8fb]">{energyArc.nextLabel}</p>
          <p className="mt-1 text-sm leading-6 text-[#9da7b7]">{energyArc.summary}</p>
        </div>
      ) : (
        <>
          <div className="mt-5 rounded-[24px] border border-white/8 bg-[#0d1017] p-4">
            <div className="flex h-36 items-end gap-2 sm:gap-3">
              {energyArc.points.map((point) => (
                <div key={point.id} className="flex min-w-0 flex-1 items-end">
                  <div
                    className={classNames(
                      "w-full rounded-full bg-[linear-gradient(180deg,#ffcd56_0%,#7de2da_54%,#8ba5ff_100%)] transition-all duration-500",
                      point.isActive
                        ? "shadow-[0_0_32px_rgba(125,226,218,0.26)] ring-1 ring-[#7de2da]/50"
                        : "opacity-72",
                    )}
                    style={{ height: `${point.heightPercent}%` }}
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <MiniStat label="Current phase" value={energyArc.currentLabel} />
            <MiniStat label="Next shift" value={energyArc.nextLabel} />
            <MiniStat label="Tempo" value={energyArc.tempoLabel} />
          </div>

          <p className="mt-4 text-sm leading-6 text-[#9da7b7]">{energyArc.summary}</p>
        </>
      )}
    </article>
  );
}

function AIReflection({ dashboard, rangeLabel }: { dashboard: DashboardData; rangeLabel: string }) {
  return (
    <article className="motion-card min-w-0 rounded-[28px] border border-[#4ecdc4]/20 bg-[#101b1f]/90 p-5">
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
    <article className="motion-card min-w-0 rounded-[28px] border border-white/10 bg-[#11141c]/90 p-5">
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
            <div key={item.title} className="motion-list-item rounded-[22px] bg-white/[0.055] p-4">
              <div className="flex gap-3 sm:gap-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-white/8 text-[#e9edf5]">
                  <Icon size={20} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="min-w-0 text-base font-semibold leading-snug text-[#f7f8fb]">
                      {item.title}
                    </h3>
                    <span
                      className={classNames(
                        "flex shrink-0 items-center gap-1 rounded-full bg-white/[0.055] px-2.5 py-1 text-sm font-semibold leading-none",
                        item.positive ? "text-[#c7f36c]" : "text-[#ff9d86]",
                      )}
                    >
                      {item.positive ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
                      <span>{item.trend}</span>
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-[#aeb7c6]">{item.detail}</p>
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
      className="motion-action grid size-10 place-items-center rounded-full border border-white/10 bg-white/[0.07] text-[#e9edf5] disabled:cursor-not-allowed disabled:opacity-50"
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

function buildTodayWindow(): TodayWindow {
  const today = new Date();
  const end = endOfDay(today);
  const start = startOfDay(today);

  return {
    end,
    label: "Today",
    start,
  };
}

function createTodayDataNotice(items: SpotifyRecentlyPlayedItem[]) {
  if (items.length === 0) {
    return "No Spotify plays were returned for today yet. Current playback will still appear when available.";
  }

  if (items.length >= 50) {
    return "Today is based on Spotify's available recent sample. Repeats count as play events, not unique songs.";
  }

  return "Today is built from Spotify's available recent plays, not a stored listening archive.";
}

function buildAnalyticsSnapshot({
  currentlyPlaying,
  profile,
  recentlyPlayed,
  todayWindow,
}: {
  currentlyPlaying: SpotifyCurrentlyPlaying | null;
  profile?: SpotifyUserProfile;
  recentlyPlayed: SpotifyRecentlyPlayedItem[];
  todayWindow: TodayWindow;
}) {
  const filteredRecentlyPlayed = filterRecentlyPlayedItemsForRange(
    recentlyPlayed,
    todayWindow.start.getTime(),
    todayWindow.end.getTime(),
  );
  const snapshotForReflection = {
    currentlyPlaying,
    profile,
    rangeEnd: todayWindow.end,
    rangeStart: todayWindow.start,
    recentlyPlayed: filteredRecentlyPlayed,
    trendRecentlyPlayed: filteredRecentlyPlayed,
  };

  return {
    filteredRecentlyPlayed,
    localDashboard: createDashboardData({
      ...snapshotForReflection,
      rangeEnd: todayWindow.end,
      rangeStart: todayWindow.start,
      trendRecentlyPlayed: filteredRecentlyPlayed,
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
