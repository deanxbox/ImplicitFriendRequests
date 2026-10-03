# Vencord: ImplicitFriendRequests

Adds an **Implicit Pending** tab to Discord's Friends page, between **Pending** and **Add Friend**. It filters your incoming friend requests down to people you have actually interacted with, and ranks them by how strong that interaction is, so the requests you are most likely to recognise are at the top.

## What it does

| Feature | Behavior |
|---|---|
| **Implicit Pending tab** | Shows incoming requests that have an interaction score above 0. Spam and ignored requests are excluded, as in vanilla Pending. |
| **Vanilla-identical rows** | Rows reuse Discord's own Pending row, so the accept and ignore buttons work the same. The request date shows if SortFriendRequests has **Show dates** enabled. |
| **Ranked by score** | Only Implicit Pending is sorted by score. The vanilla Pending tab keeps Discord's order, or SortFriendRequests' newest-first order if you use it. |
| **Builds on open** | Opening the tab searches anyone without a recent scan, highest score first, and shows a progress bar with an ETA until it finishes. |
| **Re-calculate button** | **Re-calculate Implicit Requests** sits under the search bar and rescans every incoming request. |
| **New requests** | A new incoming friend request is added to the queue and scanned automatically. |

## How the score works

A request's score is the sum of these signals. A score of 0 means no evidence, and those requests stay out of the tab.

| Signal | Points |
|---|---|
| **Affinity:** Discord's communication ranking for that user (the data Implicit Relationships uses) | Up to 50, falling off as the rank number increases (rank 0 is best) |
| **DM history:** you have a DM with them that contains messages | 15 |
| **Mentions of you:** messages they sent that mention you, found by search | 10 x log2(1 + count), capped at 40 |
| **Recency:** their latest mention of you | +10 within 30 days, +5 within 180 days |

The mention search uses the same method as the FriendRequestInteractions plugin, but runs on its own, so that plugin does not need to be installed.

## Mention scan

For each request the plugin looks up their mutual servers, then runs a message search in up to a set number of those servers plus your DM with them. It counts messages where they are the author and you are mentioned.

- Results are saved in the plugin settings and reused for 7 days. Only **Re-calculate** ignores that.
- Requests are searched one person at a time, with 3 seconds between requests.
- If Discord answers "not indexed yet" or rate limits a search, the plugin waits for the `retry_after` time before retrying.
- If Discord rate limits twice in one build, the build stops and the toolbar asks you to press **Re-calculate** to resume.
- A person whose searches all failed is not saved, so they are retried next time.

A first build for 100+ requests can take a long time at this pace. People with no mutual servers or DM are quick, since they only need the profile lookup. Heavy search use is something Discord could notice, so use the settings below to stay conservative.

## Settings

| Setting | Default | Description |
|---|---|---|
| **useAffinity** | On | Count Discord's communication affinity in the score. |
| **useDirectMessages** | On | Count an existing DM with messages in the score. |
| **scanMentions** | On | Search servers and DMs for messages that mention you. Turn off to use only affinity and DM history, with no search requests. |
| **maxGuildsPerUser** | 5 | Maximum mutual servers searched per request. |
| **rankRequests** | On | Sort Implicit Pending by score. Needs a restart to change. |

## Limitations

- Needs a message search in your mutual servers, so it cannot see people you share no server or DM with. They only qualify through affinity.
- Relies on Discord's search endpoints and their `total_results` count. These can change or be rate limited without notice.
- Scores fill in gradually. A request that qualifies only through mentions will not appear until its scan finishes.
- The tab, the row reuse, the toolbar and the sort ranking are all patches into Discord's Friends page. A Discord update that restructures it may need the patches adjusted. They were checked against the web client bundle, not every client build.
- Works alongside Implicit Relationships and SortFriendRequests, which patch the same sort. That combination has not been tested.

## Repository layout

| Path | Purpose |
|---|---|
| `index.tsx` | Plugin metadata, settings, patches, scoring, scan queue and the toolbar |
| `README.md` | This file |

## Author

Created by deanxbox.

## License

Licensed under the [GNU General Public License v3.0 or later](https://www.gnu.org/licenses/gpl-3.0.html), consistent with Vencord's source headers.
