# Spotify Data Model

Music Mirror currently uses Spotify data as a live, recent listening sample. It does not have a database yet, so it cannot build a complete listening archive by itself.

This matters because the Spotify Web API does not give this app a guaranteed "last 7 days" or "last month" play history endpoint.

## Endpoints Used Today

### Current user profile

Endpoint:

```txt
GET https://api.spotify.com/v1/me
```

Purpose in Music Mirror:

- Shows which Spotify account is connected.
- Helps confirm the access token belongs to the current user.

### Currently playing

Endpoint:

```txt
GET https://api.spotify.com/v1/me/player/currently-playing
```

Scope:

```txt
user-read-currently-playing
```

What Spotify returns:

- The item currently being played, usually a track.
- `is_playing`
- `progress_ms`
- playback state metadata such as the playback `timestamp`

Important behavior:

- This is a live playback endpoint, not history.
- If nothing is playing, Spotify can return no content.
- This data can change quickly and should be polled carefully.

### Recently played

Endpoint:

```txt
GET https://api.spotify.com/v1/me/player/recently-played
```

Scope:

```txt
user-read-recently-played
```

What Spotify returns:

- A list of play history objects.
- Each object contains a `track`.
- Each object contains `played_at`, the date and time the track was played.
- Each object may contain playback `context`, such as playlist or album context.

Request parameters:

- `limit`: default 20, maximum 50.
- `after`: Unix timestamp in milliseconds. Returns items after that cursor.
- `before`: Unix timestamp in milliseconds. Returns items before that cursor.
- `after` and `before` cannot be used together.

Important behavior:

- The maximum page size is 50 items.
- Spotify does not document a guaranteed number of days covered by this endpoint.
- The data should be treated as a recent sample, not a durable listening archive.
- A repeated song can appear multiple times because each item is a play event, not a unique track.

## What "50 Plays Today" Means

If the dashboard says a day has 50 plays, Music Mirror is counting 50 play history items whose `played_at` timestamp falls inside that local day.

That does not necessarily mean 50 unique songs.

It can happen when:

- The user played many tracks today.
- A track or playlist was repeated.
- Spotify returned only the most recent sample, and that entire sample falls inside today.
- Older days are outside the available recent sample.

In other words, "50 plays" currently means "50 Spotify play events available to the app for that day."

## Why Yesterday Or Earlier Can Be Empty

The current app asks Spotify for recent play history and then filters those returned items into day buckets.

If Spotify only returns items from today, then yesterday will show no data even if the user selected yesterday.

This is expected with the current no-database architecture:

- The app can only analyze items Spotify returns right now.
- It does not yet store plays over time.
- It cannot reconstruct older days if Spotify does not return them.

## Current App Behavior

Music Mirror currently:

1. Fetches currently playing.
2. Fetches recently played items.
3. Filters returned play history objects into the selected day.
4. Counts each play history object as one play.
5. Sends the available sample to the reflection pipeline.
6. Shows a friendly no-data message when the selected day has no returned play history.

This is useful for a demo, but it is not reliable enough for a true weekly or monthly listening history product.

## What We Cannot Claim Yet

Until Music Mirror stores listening events itself, the product should not claim:

- Complete daily history.
- Complete weekly history.
- Complete monthly history.
- Exact total listening time for days that are not fully captured.
- Exact trend changes across a week.

Safer language:

- "Based on available Spotify history"
- "Recent Spotify sample"
- "Available plays for this selected day"
- "No returned listening history for this day"

Avoid:

- "Your full week"
- "All tracks from yesterday"
- "Monthly evolution"
- "Complete listening history"

## What We Need For Reliable History

To make Music Mirror behave like WHOOP or Apple Health for music, we need our own history layer.

Recommended next architecture:

1. Add a database.
2. Store normalized play events with:
   - Spotify user ID
   - track ID
   - track name
   - artist names
   - album image
   - `played_at`
   - ingestion timestamp
3. Poll recently played while the user uses the app.
4. De-duplicate by `track.id + played_at`.
5. Build daily, weekly, and monthly views from stored events.
6. Label older ranges as unavailable until enough data has been collected.

With that architecture, the product can say:

- "Music Mirror has collected 3 days of listening history."
- "Weekly trends are available after 7 days of collection."
- "Monthly evolution is available after 30 days of collection."

## Alternative Spotify Data

Spotify also has a "top items" endpoint:

```txt
GET https://api.spotify.com/v1/me/top/{type}
```

Scope:

```txt
user-top-read
```

It can return top artists or tracks across:

- `short_term`, approximately the last 4 weeks
- `medium_term`, approximately the last 6 months
- `long_term`, approximately 1 year

This is not listening history. It is Spotify-calculated affinity data. It can support a separate "longer-term taste profile" feature, but it cannot tell us exactly what the user played yesterday.

## Sources

- Spotify Web API, Get Recently Played Tracks: https://developer.spotify.com/documentation/web-api/reference/get-recently-played
- Spotify Web API, Get Currently Playing Track: https://developer.spotify.com/documentation/web-api/reference/get-the-users-currently-playing-track
- Spotify Web API, Get User's Top Items: https://developer.spotify.com/documentation/web-api/reference/get-users-top-artists-and-tracks
- Spotify Web API, Rate Limits: https://developer.spotify.com/documentation/web-api/concepts/rate-limits
