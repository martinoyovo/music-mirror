import type { DashboardTrack, SpotifyTrackAudioAnalysis } from "./types";

export type EnergyArcStatus = "idle" | "loading" | "ready" | "unavailable";

export type EnergyArcData = {
  currentLabel: string;
  nextLabel: string;
  points: Array<{
    heightPercent: number;
    id: string;
    isActive: boolean;
  }>;
  sourceLabel: string;
  status: EnergyArcStatus;
  summary: string;
  tempoLabel: string;
  title: string;
};

export function createEnergyArcData({
  analysis,
  isPlaying,
  status,
  tempoLabel,
  track,
}: {
  analysis: SpotifyTrackAudioAnalysis | null;
  isPlaying: boolean;
  status: EnergyArcStatus;
  tempoLabel: string;
  track?: DashboardTrack;
}): EnergyArcData {
  if (!track) {
    return {
      currentLabel: "Waiting",
      nextLabel: "Start a track",
      points: [],
      sourceLabel: "Idle",
      status: "idle",
      summary: "Start playing something on Spotify to reveal the current song's motion.",
      tempoLabel: "-",
      title: "Live energy arc",
    };
  }

  if (status === "idle" || status === "loading") {
    return {
      currentLabel: "Reading structure",
      nextLabel: "Preparing arc",
      points: [],
      sourceLabel: "Loading",
      status: "loading",
      summary: `Reading Spotify's section map for "${track.name}".`,
      tempoLabel,
      title: `"${track.name}" is loading`,
    };
  }

  if (status === "unavailable" || !analysis || analysis.sections.length === 0) {
    return {
      currentLabel: isPlaying ? "Playing live" : "Paused",
      nextLabel: "Analysis unavailable",
      points: [],
      sourceLabel: "Fallback",
      status: "unavailable",
      summary:
        "Spotify did not return section analysis for this song, so a live energy arc is not available here.",
      tempoLabel,
      title: `"${track.name}" is live`,
    };
  }

  const normalizedSections = normalizeSections(analysis.sections);
  const progressSeconds = Math.max(0, (track.progressMs ?? 0) / 1000);
  const currentSectionIndex = findCurrentSectionIndex(normalizedSections, progressSeconds);
  const currentSection = normalizedSections[currentSectionIndex] ?? normalizedSections[0];
  const nextSection = normalizedSections[currentSectionIndex + 1];
  const condensedPoints = condenseSections(normalizedSections, progressSeconds);

  return {
    currentLabel: describeEnergyLevel(currentSection.intensity),
    nextLabel: createNextShiftLabel(currentSection, nextSection, progressSeconds),
    points: condensedPoints,
    sourceLabel: "Spotify analysis",
    status: "ready",
    summary: createSummary(track.name, currentSection.intensity, nextSection, progressSeconds),
    tempoLabel: `${Math.round(currentSection.tempo || analysis.track.tempo || Number(tempoLabel) || 0)} BPM`,
    title: `"${track.name}" energy arc`,
  };
}

function normalizeSections(sections: SpotifyTrackAudioAnalysis["sections"]) {
  const loudnessValues = sections.map((section) => section.loudness);
  const tempoValues = sections.map((section) => section.tempo);
  const minLoudness = Math.min(...loudnessValues);
  const maxLoudness = Math.max(...loudnessValues);
  const minTempo = Math.min(...tempoValues);
  const maxTempo = Math.max(...tempoValues);

  return sections.map((section) => {
    const loudnessScore = normalize(section.loudness, minLoudness, maxLoudness);
    const tempoScore = normalize(section.tempo, minTempo, maxTempo);
    const intensity = clamp(0.72 * loudnessScore + 0.28 * tempoScore, 0, 1);

    return {
      durationSeconds: section.duration,
      endSeconds: section.start + section.duration,
      id: `${section.start}-${section.duration}`,
      intensity,
      startSeconds: section.start,
      tempo: section.tempo,
    };
  });
}

function findCurrentSectionIndex(
  sections: Array<{ endSeconds: number; startSeconds: number }>,
  progressSeconds: number,
) {
  const index = sections.findIndex(
    (section) =>
      progressSeconds >= section.startSeconds && progressSeconds < section.endSeconds,
  );

  if (index !== -1) {
    return index;
  }

  return Math.max(0, sections.length - 1);
}

function condenseSections(
  sections: Array<{
    endSeconds: number;
    id: string;
    intensity: number;
    startSeconds: number;
  }>,
  progressSeconds: number,
) {
  const bucketCount = Math.min(8, sections.length);
  const buckets = Array.from({ length: bucketCount }, (_, index) => {
    const start = Math.floor((index * sections.length) / bucketCount);
    const end = Math.floor(((index + 1) * sections.length) / bucketCount);
    const bucketSections = sections.slice(start, Math.max(start + 1, end));
    const averageIntensity =
      bucketSections.reduce((total, section) => total + section.intensity, 0) /
      bucketSections.length;
    const active = bucketSections.some(
      (section) =>
        progressSeconds >= section.startSeconds && progressSeconds < section.endSeconds,
    );

    return {
      heightPercent: Math.round(28 + averageIntensity * 72),
      id: bucketSections[0]?.id ?? `bucket-${index}`,
      isActive: active,
    };
  });

  if (!buckets.some((bucket) => bucket.isActive) && buckets.length > 0) {
    buckets[buckets.length - 1].isActive = true;
  }

  return buckets;
}

function createSummary(
  trackName: string,
  currentIntensity: number,
  nextSection:
    | {
        intensity: number;
        startSeconds: number;
      }
    | undefined,
  progressSeconds: number,
) {
  const currentCopy = describeEnergySentence(currentIntensity);

  if (!nextSection) {
    return `"${trackName}" is in its closing stretch, with the energy holding ${currentCopy}.`;
  }

  const secondsUntilShift = Math.max(0, Math.round(nextSection.startSeconds - progressSeconds));
  const direction = nextSection.intensity >= currentIntensity ? "lifts" : "settles";

  return `"${trackName}" is ${currentCopy} right now and ${direction} again in about ${secondsUntilShift}s.`;
}

function createNextShiftLabel(
  currentSection: { intensity: number },
  nextSection:
    | {
        intensity: number;
        startSeconds: number;
      }
    | undefined,
  progressSeconds: number,
) {
  if (!nextSection) {
    return "Outro ahead";
  }

  const secondsUntilShift = Math.max(0, Math.round(nextSection.startSeconds - progressSeconds));
  const intensityDelta = nextSection.intensity - currentSection.intensity;

  if (intensityDelta > 0.1) {
    return `Lift in ${secondsUntilShift}s`;
  }

  if (intensityDelta < -0.1) {
    return `Drop in ${secondsUntilShift}s`;
  }

  return `Shift in ${secondsUntilShift}s`;
}

function describeEnergyLevel(intensity: number) {
  if (intensity >= 0.82) {
    return "Peak";
  }

  if (intensity >= 0.62) {
    return "Surging";
  }

  if (intensity >= 0.42) {
    return "Building";
  }

  return "Low glide";
}

function describeEnergySentence(intensity: number) {
  if (intensity >= 0.82) {
    return "near its peak";
  }

  if (intensity >= 0.62) {
    return "strong and rising";
  }

  if (intensity >= 0.42) {
    return "steady with some lift";
  }

  return "soft and restrained";
}

function normalize(value: number, min: number, max: number) {
  if (max === min) {
    return 0.5;
  }

  return (value - min) / (max - min);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
