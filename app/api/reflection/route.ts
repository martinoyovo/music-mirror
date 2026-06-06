import OpenAI from "openai";
import { NextResponse } from "next/server";
import { createDashboardData } from "@/lib/spotify/dashboardTransform";
import type {
  DashboardData,
  DashboardMood,
  DashboardObservation,
  DashboardTrend,
  MoodName,
  SpotifyCurrentlyPlaying,
  SpotifyRecentlyPlayedItem,
  SpotifyUserProfile,
  ThemeName,
} from "@/lib/spotify/types";

type ReflectionRequestBody = {
  aggregation?: "day" | "week";
  currentlyPlaying: SpotifyCurrentlyPlaying | null;
  profile?: SpotifyUserProfile;
  rangeEnd?: string;
  rangeStart?: string;
  recentlyPlayed: SpotifyRecentlyPlayedItem[];
  trendRecentlyPlayed?: SpotifyRecentlyPlayedItem[];
};

type OpenAIReflectionPayload = {
  currentMood: {
    description: string;
    label: MoodName;
    score: number;
    trendLabel: string;
  };
  interestingObservations: DashboardObservation[];
  moodBreakdown: Array<Omit<DashboardMood, "color">>;
  reflection: DashboardData["reflection"];
  themeSignal: {
    description: string;
    label: ThemeName | null;
    strength: number;
  };
  weeklyTrend: DashboardTrend[];
};

type ReflectionNotice = {
  code:
    | "missing_openai_key"
    | "insufficient_quota"
    | "openai_auth_error"
    | "openai_timeout"
    | "invalid_openai_output"
    | "openai_unavailable";
  message: string;
};

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const moodColors: Record<MoodName, string> = {
  Energetic: "bg-[#ff7a5c]",
  Moody: "bg-[#b58cff]",
  Uplifting: "bg-[#ffcd56]",
  Calm: "bg-[#4ecdc4]",
  Reflective: "bg-[#8ba5ff]",
  Focused: "bg-[#c7f36c]",
};

const responseSchema = {
  additionalProperties: false,
  properties: {
    currentMood: {
      additionalProperties: false,
      properties: {
        description: { type: "string" },
        label: {
          enum: ["Calm", "Uplifting", "Reflective", "Energetic", "Focused", "Moody"],
          type: "string",
        },
        score: { maximum: 100, minimum: 0, type: "integer" },
        trendLabel: { type: "string" },
      },
      required: ["description", "label", "score", "trendLabel"],
      type: "object",
    },
    interestingObservations: {
      items: {
        additionalProperties: false,
        properties: {
          detail: { type: "string" },
          icon: { enum: ["sunrise", "activity", "waves"], type: "string" },
          positive: { type: "boolean" },
          title: { type: "string" },
          trend: { type: "string" },
        },
        required: ["detail", "icon", "positive", "title", "trend"],
        type: "object",
      },
      maxItems: 3,
      minItems: 3,
      type: "array",
    },
    moodBreakdown: {
      items: {
        additionalProperties: false,
        properties: {
          label: {
            enum: ["Calm", "Uplifting", "Reflective", "Energetic", "Focused", "Moody"],
            type: "string",
          },
          value: { maximum: 100, minimum: 0, type: "integer" },
        },
        required: ["label", "value"],
        type: "object",
      },
      maxItems: 6,
      minItems: 6,
      type: "array",
    },
    reflection: {
      additionalProperties: false,
      properties: {
        body: { type: "string" },
        headline: { type: "string" },
        summary: { type: "string" },
      },
      required: ["body", "headline", "summary"],
      type: "object",
    },
    themeSignal: {
      additionalProperties: false,
      properties: {
        description: { type: "string" },
        label: {
          enum: ["Spiritual", "Romance", "Nostalgia", "Confidence", "Community", "Rest", null],
        },
        strength: { maximum: 100, minimum: 0, type: "integer" },
      },
      required: ["description", "label", "strength"],
      type: "object",
    },
    weeklyTrend: {
      items: {
        additionalProperties: false,
        properties: {
          day: { type: "string" },
          height: { type: "string" },
          mood: { type: "string" },
        },
        required: ["day", "height", "mood"],
        type: "object",
      },
      maxItems: 7,
      minItems: 7,
      type: "array",
    },
  },
  required: [
    "currentMood",
    "interestingObservations",
    "moodBreakdown",
    "reflection",
    "themeSignal",
    "weeklyTrend",
  ],
  type: "object",
} as const;

export async function POST(request: Request) {
  const body = (await request.json()) as ReflectionRequestBody;
  const fallbackDashboard = createDashboardData({
    currentlyPlaying: body.currentlyPlaying,
    profile: body.profile,
    rangeEnd: parseOptionalDate(body.rangeEnd),
    rangeStart: parseOptionalDate(body.rangeStart),
    recentlyPlayed: body.recentlyPlayed,
    trendRecentlyPlayed: body.trendRecentlyPlayed,
  });

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({
      dashboard: fallbackDashboard,
      notice: createReflectionNotice("missing_openai_key"),
      source: "local",
    });
  }

  try {
    const response = await client.responses.create({
      input: JSON.stringify(createPromptPayload(body, fallbackDashboard)),
      instructions:
        "You generate concise JSON insights for a music listening dashboard. Do not make medical claims, diagnose emotions, or infer personality. Use wording like 'your listening suggests' and 'your recent tracks lean toward.' When relevant, mention one or two specific song titles that support the reflection, and wrap those titles in straight double quotes. Do not use em dashes. Return structured output only.",
      max_output_tokens: 1400,
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      text: {
        format: {
          name: "music_mirror_reflection",
          schema: responseSchema,
          strict: true,
          type: "json_schema",
        },
        verbosity: "medium",
      },
    });

    const aiPayload = parseReflectionPayload(response.output_text);
    if (!aiPayload) {
      const invalidOutputError = new Error(
        "OpenAI Responses API did not return structured reflection output.",
      ) as Error & { code?: string };
      invalidOutputError.code = "invalid_openai_output";
      throw invalidOutputError;
    }

    return NextResponse.json({
      dashboard: mergeReflectionPayload(fallbackDashboard, aiPayload),
      source: "openai",
    });
  } catch (error) {
    const errorSummary = getOpenAIErrorSummary(error);
    console.error("OpenAI reflection generation failed", errorSummary);
    return NextResponse.json({
      dashboard: fallbackDashboard,
      notice: createReflectionNotice(getReflectionNoticeCode(errorSummary)),
      source: "local",
    });
  }
}

function parseOptionalDate(value?: string) {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseReflectionPayload(outputText: string): OpenAIReflectionPayload | null {
  if (!outputText) {
    return null;
  }

  try {
    return JSON.parse(outputText) as OpenAIReflectionPayload;
  } catch {
    return null;
  }
}

function isBillingOrQuotaError(errorSummary: ReturnType<typeof getOpenAIErrorSummary>) {
  const message = errorSummary.message.toLowerCase();
  return (
    errorSummary.code === "insufficient_quota" ||
    errorSummary.status === 429 ||
    message.includes("quota") ||
    message.includes("billing")
  );
}

function createReflectionNotice(code: ReflectionNotice["code"]): ReflectionNotice {
  if (code === "insufficient_quota") {
    return {
      code,
      message:
        "AI reflections are temporarily using local insights because the OpenAI project needs billing or quota attention.",
    };
  }

  if (code === "missing_openai_key") {
    return {
      code,
      message:
        "AI reflections are temporarily using local insights because the OpenAI key is not configured.",
    };
  }

  if (code === "openai_auth_error") {
    return {
      code,
      message:
        "AI reflections are temporarily using local insights because the OpenAI key was rejected.",
    };
  }

  if (code === "openai_timeout") {
    return {
      code,
      message:
        "AI reflections are temporarily using local insights because the OpenAI request took too long.",
    };
  }

  if (code === "invalid_openai_output") {
    return {
      code,
      message:
        "AI reflections are temporarily using local insights because OpenAI returned an unreadable reflection.",
    };
  }

  return {
    code,
    message: "AI reflections are temporarily using local insights while the AI service recovers.",
  };
}

function getOpenAIErrorSummary(error: unknown) {
  if (error instanceof Error) {
    const maybeApiError = error as Error & {
      code?: string;
      cause?: { code?: string; errno?: string };
      status?: number;
      type?: string;
    };

    return {
      causeCode: maybeApiError.cause?.code ?? maybeApiError.cause?.errno,
      code: maybeApiError.code,
      message: maybeApiError.message,
      status: maybeApiError.status,
      type: maybeApiError.type,
    };
  }

  return { message: "Unknown OpenAI error" };
}

function getReflectionNoticeCode(
  errorSummary: ReturnType<typeof getOpenAIErrorSummary>,
): ReflectionNotice["code"] {
  const message = errorSummary.message.toLowerCase();

  if (isBillingOrQuotaError(errorSummary)) {
    return "insufficient_quota";
  }

  if (
    errorSummary.status === 401 ||
    errorSummary.status === 403 ||
    errorSummary.code === "invalid_api_key" ||
    message.includes("invalid api key") ||
    message.includes("incorrect api key") ||
    message.includes("authentication")
  ) {
    return "openai_auth_error";
  }

  if (
    errorSummary.code === "invalid_openai_output" ||
    message.includes("structured reflection output") ||
    message.includes("json")
  ) {
    return "invalid_openai_output";
  }

  if (
    errorSummary.status === 408 ||
    errorSummary.code === "timeout" ||
    errorSummary.causeCode === "ETIMEDOUT" ||
    errorSummary.causeCode === "UND_ERR_CONNECT_TIMEOUT" ||
    message.includes("timed out") ||
    message.includes("timeout")
  ) {
    return "openai_timeout";
  }

  return "openai_unavailable";
}

function createPromptPayload(
  body: ReflectionRequestBody,
  fallbackDashboard: DashboardData,
) {
  return {
    analysisContext: {
      aggregation: body.aggregation ?? "day",
      rangeEnd: body.rangeEnd ?? null,
      rangeStart: body.rangeStart ?? null,
    },
    currentDashboardFallback: {
      currentMood: fallbackDashboard.currentMood,
      moodBreakdown: fallbackDashboard.moodBreakdown.map(({ label, value }) => ({
        label,
        value,
      })),
      themeSignal: fallbackDashboard.themeSignal,
      weeklyTrend: fallbackDashboard.weeklyTrend,
    },
    currentlyPlaying: body.currentlyPlaying?.item
      ? {
          artist: body.currentlyPlaying.item.artists.map((artist) => artist.name).join(", "),
          durationMs: body.currentlyPlaying.item.duration_ms,
          isPlaying: body.currentlyPlaying.is_playing,
          name: body.currentlyPlaying.item.name,
          progressMs: body.currentlyPlaying.progress_ms,
        }
      : null,
    instructions: [
      "Use the supplied Spotify tracks only.",
      "Keep copy concise enough for dashboard cards.",
      "Do not make medical, diagnostic, personality, or certainty-heavy claims.",
      "Use observational language: 'suggests', 'leans toward', 'recent tracks show'.",
      'When specific tracks support the point, mention one or two song titles and wrap them in straight double quotes, like "Track Title".',
      "Do not use em dashes in any output text.",
      "Use exactly the six mood labels provided in the schema.",
      "Use the supplied track names and artists to infer the theme signal when possible, but leave the theme label null if the pattern is weak.",
      "The moodBreakdown values should be whole percentages and total roughly 100.",
      "The weeklyTrend heights must be percentage strings such as '42%'.",
      "If listening history is sparse, say that the reflection is based on the available listening history.",
    ],
    recentlyPlayed: body.recentlyPlayed.slice(0, 20).map((item) => ({
      artist: item.track.artists.map((artist) => artist.name).join(", "),
      durationMs: item.track.duration_ms,
      name: item.track.name,
      playedAt: item.played_at,
    })),
    trendRecentlyPlayed: (body.trendRecentlyPlayed ?? body.recentlyPlayed).slice(0, 40).map((item) => ({
      artist: item.track.artists.map((artist) => artist.name).join(", "),
      durationMs: item.track.duration_ms,
      name: item.track.name,
      playedAt: item.played_at,
    })),
  };
}

function mergeReflectionPayload(
  fallbackDashboard: DashboardData,
  aiPayload: OpenAIReflectionPayload,
): DashboardData {
  return {
    ...fallbackDashboard,
    currentMood: {
      ...fallbackDashboard.currentMood,
      description: aiPayload.currentMood.description,
      label: aiPayload.currentMood.label,
      score: aiPayload.currentMood.score,
      trendLabel: aiPayload.currentMood.trendLabel,
    },
    moodBreakdown: aiPayload.moodBreakdown.map((mood) => ({
      ...mood,
      color: moodColors[mood.label],
    })),
    observations: aiPayload.interestingObservations,
    reflection: aiPayload.reflection,
    themeSignal: aiPayload.themeSignal,
    weeklyTrend: aiPayload.weeklyTrend,
  };
}
