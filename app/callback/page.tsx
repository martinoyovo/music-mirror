"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, Headphones } from "lucide-react";
import { SpotifyAuthService } from "@/lib/spotify/SpotifyAuthService";

export default function SpotifyCallbackPage() {
  const [message, setMessage] = useState("Finishing Spotify connection");
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    async function completeSpotifyConnection() {
      try {
        await SpotifyAuthService.completeRedirectIfNeeded();
        window.location.replace("/");
      } catch (error) {
        setHasError(true);
        setMessage(
          error instanceof Error
            ? error.message
            : "Spotify connection failed. Please try linking your account again.",
        );
      }
    }

    completeSpotifyConnection();
  }, []);

  return (
    <main className="mx-auto grid min-h-screen w-full max-w-5xl place-items-center px-4 text-white sm:px-6 lg:px-8">
      <section className="w-full max-w-md rounded-[28px] border border-white/10 bg-[#151922]/90 p-5 text-center shadow-[0_18px_70px_rgba(0,0,0,0.32)]">
        <span className="mx-auto grid size-12 place-items-center rounded-full bg-[#f7f8fb] text-[#08090d]">
          <Headphones size={21} strokeWidth={2.4} />
        </span>
        <h1 className="mt-5 text-3xl font-semibold">
          {hasError ? "Connection needs a retry" : "Connecting Spotify"}
        </h1>
        <p className="mt-3 text-sm leading-6 text-[#aeb7c6]">{message}</p>
        {hasError && (
          <button
            className="mt-5 inline-flex items-center gap-2 rounded-full bg-[#f7f8fb] px-4 py-2 text-sm font-semibold text-[#08090d]"
            onClick={() => window.location.replace(SpotifyAuthService.getPreferredAppUrl("/"))}
            type="button"
          >
            Try again
            <ArrowUpRight size={16} />
          </button>
        )}
      </section>
    </main>
  );
}
