/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { RelationshipType } from "@vencord/discord-types/enums";
import { findByPropsLazy } from "@webpack";
import { ChannelStore, Constants, FluxDispatcher, RelationshipStore, RestAPI, useEffect, UserAffinitiesStore, UserProfileStore, UserStore, useState } from "@webpack/common";
import type { JSX } from "react";

const logger = new Logger("ImplicitFriendRequests");
const SECTION = "IMPLICIT_PENDING";
const REQUEST_DELAY_MS = 3000;
const COOLDOWN_AFTER_LIMIT_MS = 15 * 60 * 1000;
let rateLimitStrikes = 0;
const DAY = 24 * 60 * 60 * 1000;
const RESCAN_AFTER_MS = 7 * DAY;
const MAX_RETRIES = 3;

const UserProfileActions = findByPropsLazy("fetchProfile", "fetchMutualFriends") as {
    fetchProfile(userId: string, options?: { withMutualGuilds?: boolean; withMutualFriendsCount?: boolean; }): Promise<void>;
};

type MentionInfo = { total: number; latest: number; scannedAt: number; };

const settings = definePluginSettings({
    useAffinity: {
        type: OptionType.BOOLEAN,
        description: "Count requesters Discord has an affinity (frequent-contact ranking) for - the data Implicit Relationships uses",
        default: true
    },
    useDirectMessages: {
        type: OptionType.BOOLEAN,
        description: "Count requesters you already have a DM conversation with",
        default: true
    },
    scanMentions: {
        type: OptionType.BOOLEAN,
        description: "Search mutual servers and DMs for messages where the requester mentioned you (same method as FriendRequestInteractions). Runs slowly in the background.",
        default: true
    },
    maxGuildsPerUser: {
        type: OptionType.SLIDER,
        description: "Maximum mutual servers searched per requester",
        markers: [1, 3, 5, 10, 15, 20],
        default: 5,
        stickToMarkers: false
    },
    rankRequests: {
        type: OptionType.BOOLEAN,
        description: "Sort the Implicit Pending tab by interaction score, best first (vanilla Pending is untouched)",
        default: true,
        restartNeeded: true
    },
    mentionCache: {
        type: OptionType.CUSTOM,
        default: {} as Record<string, MentionInfo>
    }
});

function getAffinityRank(userId: string): number | null {
    const affinity = UserAffinitiesStore?.getUserAffinity(userId);
    if (!affinity) return null;
    const rank = Number((affinity as any).communicationRank);
    return Number.isFinite(rank) ? rank : 0;
}

function hasDmHistory(userId: string) {
    const dmId = ChannelStore.getDMFromUserId(userId);
    return !!dmId && !!ChannelStore.getChannel(dmId)?.lastMessageId;
}

/**
 * Interaction score, 0 = no evidence. Components:
 *  - affinity: up to 50, decaying with Discord's communication rank (rank 0 = best)
 *  - DM history: 15
 *  - mentions of you: 10 * log2(1 + count), capped at 40
 *  - recency of their latest mention: +10 within 30 days, +5 within 180
 */
function getScore(userId: string) {
    let score = 0;

    if (settings.store.useAffinity) {
        const rank = getAffinityRank(userId);
        if (rank !== null) score += 50 / (1 + rank);
    }
    if (settings.store.useDirectMessages && hasDmHistory(userId)) score += 15;

    const info = settings.store.mentionCache[userId];
    if (info?.total) {
        score += Math.min(40, 10 * Math.log2(1 + info.total));
        const age = Date.now() - info.latest;
        if (age < 30 * DAY) score += 10;
        else if (age < 180 * DAY) score += 5;
    }
    return score;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function searchMentions(url: string, authorId: string, mentionedId: string): Promise<{ total: number; latest: number; } | null> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await RestAPI.get({
                url,
                query: { author_id: authorId, mentions: mentionedId, sort_by: "timestamp", sort_order: "desc", include_nsfw: true, limit: 1 },
                retries: 1
            });
            const body = response.body as any;

            if (response.status === 202) {
                await sleep((Number(body?.retry_after) || 1) * 1000);
                continue;
            }

            const first = body?.messages?.flat?.()?.[0];
            return {
                total: Number(body?.total_results) || 0,
                latest: first?.timestamp ? Date.parse(first.timestamp) : 0
            };
        } catch (error: any) {
            const status = error?.status ?? error?.response?.status;
            const retryAfter = Number(error?.body?.retry_after ?? error?.response?.body?.retry_after);
            if (status === 429) rateLimitStrikes++;
            if ((status === 202 || status === 429) && attempt < MAX_RETRIES) {
                await sleep((retryAfter || 5) * 1000);
                continue;
            }
            logger.warn("Search failed for " + url, error);
            return null;
        }
    }
    return null;
}

async function scanUser(userId: string, myId: string) {
    let guilds = UserProfileStore.getMutualGuilds(userId);
    if (guilds == null) {
        try {
            await UserProfileActions.fetchProfile(userId, { withMutualGuilds: true, withMutualFriendsCount: false });
        } catch (error) {
            logger.warn("Failed to fetch mutual guilds", error);
        }
        await sleep(REQUEST_DELAY_MS);
        guilds = UserProfileStore.getMutualGuilds(userId);
    }

    const urls = (guilds ?? []).slice(0, settings.store.maxGuildsPerUser).map(({ guild }) => "/guilds/" + guild.id + "/messages/search");
    const dmId = ChannelStore.getDMFromUserId(userId);
    if (dmId) urls.push("/channels/" + dmId + "/messages/search");

    let total = 0;
    let latest = 0;
    let failed = false;
    for (const url of urls) {
        const result = await searchMentions(url, userId, myId);
        if (result) {
            total += result.total;
            latest = Math.max(latest, result.latest);
        } else failed = true;
        await sleep(REQUEST_DELAY_MS);
    }

    // A fully failed scan is not cached, so it is retried on the next pass.
    if (failed && total === 0) return;
    settings.store.mentionCache = {
        ...settings.store.mentionCache,
        [userId]: { total, latest, scannedAt: Date.now() }
    };
    RelationshipStore.emitChange();
}

// ---- Build state: the Implicit Pending page builds itself when opened ----

type BuildState = {
    running: boolean;
    paused: boolean;
    done: number;
    total: number;
    startedAt: number;
};

const build: BuildState = { running: false, paused: false, done: 0, total: 0, startedAt: 0 };
let queue: string[] = [];
let stopped = true;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(l => l());

function isStale(id: string) {
    return Date.now() - (settings.store.mentionCache[id]?.scannedAt ?? 0) > RESCAN_AFTER_MS;
}

function getIncomingIds() {
    return [...RelationshipStore.getMutableRelationships().entries()]
        .filter(([, type]) => type === RelationshipType.INCOMING_REQUEST)
        .map(([id]) => id);
}

async function runQueue() {
    if (build.running) return;
    const me = UserStore.getCurrentUser();
    if (!me) return;

    build.running = true;
    build.paused = false;
    rateLimitStrikes = 0;
    notify();

    try {
        while (queue.length && !stopped) {
            const id = queue.shift()!;
            await scanUser(id, me.id);
            build.done++;
            notify();

            // Discord is throttling us: stop and let the user resume with the button rather than hammering it.
            if (rateLimitStrikes >= 2) {
                logger.warn("Rate limited by Discord, pausing Implicit Pending build");
                build.paused = true;
                queue = [];
                break;
            }
        }
    } catch (error) {
        logger.error("Implicit Pending build failed", error);
    } finally {
        build.running = false;
        if (!build.paused) {
            build.done = build.total = 0;
        }
        notify();
    }
}

function enqueue(ids: string[]) {
    if (!settings.store.scanMentions || stopped) return;
    const fresh = ids.filter(id => !queue.includes(id));
    if (!fresh.length) return;

    if (!build.running) {
        build.done = 0;
        build.total = 0;
        build.startedAt = Date.now();
    }
    queue.push(...fresh);
    build.total += fresh.length;
    runQueue();
}

/** Opening the page: only people without a recent scan are searched. */
function buildPage() {
    enqueue(getIncomingIds().filter(isStale).sort((a, b) => getScore(b) - getScore(a)));
}

/** Re-calculate button: everyone is searched again. */
function recalculateAll() {
    build.paused = false;
    enqueue(getIncomingIds().sort((a, b) => getScore(b) - getScore(a)));
    notify();
}

function onRelationshipAdd(event: { relationship?: { id?: string; type?: number; }; }) {
    const rel = event?.relationship;
    if (rel?.id && rel.type === RelationshipType.INCOMING_REQUEST) enqueue([rel.id]);
}

function formatEta(ms: number) {
    const s = Math.max(1, Math.round(ms / 1000));
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m " + (s % 60) + "s";
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
}

function Toolbar() {
    const [, setTick] = useState(0);

    useEffect(() => {
        const l = () => setTick(t => t + 1);
        listeners.add(l);
        buildPage();
        // keep the ETA ticking between completed users
        const interval = setInterval(l, 1000);
        return () => {
            listeners.delete(l);
            clearInterval(interval);
        };
    }, []);

    const { running, paused, done, total, startedAt } = build;
    const pct = total ? Math.min(100, (done / total) * 100) : 0;
    const eta = done > 0 ? formatEta(((Date.now() - startedAt) / done) * (total - done)) : "estimating...";

    return (
        <div style={{ padding: "8px 16px 0", display: "flex", alignItems: "center", gap: 16 }}>
            <Button size="small" variant="secondary" disabled={running} onClick={recalculateAll}>
                Re-calculate Implicit Requests
            </Button>
            {running && (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
                    <BaseText size="xs" weight="medium">
                        {"Building Implicit Pending: " + done + "/" + total + " (" + Math.round(pct) + "%) - ETA " + eta}
                    </BaseText>
                    <div style={{ height: 6, borderRadius: 3, background: "var(--background-mod-strong)", overflow: "hidden" }}>
                        <div style={{ width: pct + "%", height: "100%", background: "var(--brand-500)", transition: "width 0.3s" }} />
                    </div>
                </div>
            )}
            {!running && paused && (
                <BaseText size="xs" weight="medium">
                    Discord rate limited the search. Press Re-calculate to resume later.
                </BaseText>
            )}
        </div>
    );
}

export default definePlugin({
    name: "ImplicitFriendRequests",
    description: "Adds an Implicit Pending tab to Friends that filters incoming friend requests to people you have interacted with, ranked by interaction score",
    tags: ["Friends"],
    authors: [{ name: "dean", id: 285021062578700289n }],
    settings,

    patches: [
        // Tab header (sits after Pending, before Add Friend)
        {
            find: "#{intl::FRIENDS_SECTION_ONLINE}),className:",
            replacement: {
                match: /(,\{id:\i\.\i\.PENDING,show:.+?className:(\i\.\i))(?=\},\{id:)/,
                replace: "$1},{id:\"" + SECTION + "\",show:true,className:$2,content:\"Implicit Pending\""
            }
        },
        // List header counts
        {
            find: "#{intl::FRIENDS_ALL_HEADER}",
            replacement: {
                match: /toString\(\)\}\);(?=case \i\.\i\.(?:PENDING|IMPLICIT))/,
                replace: "$&case \"" + SECTION + "\":return \"Implicit Pending — \"+arguments[1];"
            }
        },
        // Empty state
        {
            find: "FriendsEmptyState: Invalid empty state",
            replacement: {
                match: /case (\i\.\i)\.ONLINE:(?=(?:case \i\.\i\.IMPLICIT:)?return \i\.SECTION_ONLINE)/,
                replace: "case \"" + SECTION + "\":$&"
            }
        },
        // Row filter
        {
            find: '"FriendsStore"',
            replacement: {
                match: /(?<=case (\i\.\i)\.SUGGESTIONS:return \d+===(\i)\.type)/,
                replace: ";case \"" + SECTION + "\":return 3===$2.type&&!$2.spam&&!$2.ignoredUser&&$self.hasInteracted($2.user?.id)"
            }
        },
        // Render rows with the vanilla Pending row (accept/ignore buttons, request date)
        {
            find: "Unexpected pending friend requests section index",
            replacement: {
                match: /case (\i\.\i)\.PENDING:(?=return\(0,\i\.jsxs?\)\(\i,\{\.\.\.\i,isFocused:\i\},\i\);case \i\.\i\.SUGGESTIONS)/,
                replace: "case \"" + SECTION + "\":case $1.PENDING:"
            }
        },
        // Toolbar under the search bar, only on the Implicit Pending tab
        {
            find: "Unexpected pending friend requests section index",
            replacement: {
                match: /(query:\i\[(\i)\],onChange:\i,onClear:\i\}\)\}\),)/,
                replace: "$1$2===\"" + SECTION + "\"&&$self.renderToolbar(),"
            }
        },
        // Keep the toolbar visible when the tab has no rows yet, so the build can run
        {
            find: "Unexpected pending friend requests section index",
            replacement: {
                match: /,0===(\i)\.length&&""===(\i)\[(\i)\]\)return(\(0,\i\.jsx\)\(\i,\{section:\3,showSpamCta:\i\}\));/,
                replace: ",0===$1.length&&\"\"===$2[$3])return $self.renderEmpty($3,$4);"
            }
        },
        // Ranking; wraps the existing comparator, so it composes with ImplicitRelationships' own wrapper
        {
            find: "getRelationshipCounts(){",
            replacement: {
                predicate: () => settings.store.rankRequests,
                match: /(?<=filter\((\i),\i\)\{return .{0,1500}?)\}\)\.sortBy\((.+?)\)\.value\(\)/,
                replace: "}).sortBy(row => $self.wrapSort(($2), row, $1)).value()"
            }
        }
    ],

    hasInteracted(userId?: string) {
        return !!userId
            && RelationshipStore.getRelationshipType(userId) === RelationshipType.INCOMING_REQUEST
            && getScore(userId) > 0;
    },

    wrapSort(comparator: Function, row: any, section?: string) {
        // Only Implicit Pending is ranked by score; vanilla Pending keeps Discord / SortFriendRequests date ordering.
        return section === SECTION && row.type === RelationshipType.INCOMING_REQUEST
            ? -getScore(row.user.id)
            : comparator(row);
    },

    renderToolbar: ErrorBoundary.wrap(Toolbar, { noop: true }),

    renderEmpty(section: string, vanilla: JSX.Element) {
        if (section !== SECTION) return vanilla;
        return (
            <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
                <Toolbar />
                {vanilla}
            </div>
        );
    },

    start() {
        stopped = false;
        Constants.FriendsSections[SECTION] = SECTION;
        FluxDispatcher.subscribe("RELATIONSHIP_ADD", onRelationshipAdd);
    },

    stop() {
        stopped = true;
        queue = [];
        build.running = false;
        FluxDispatcher.unsubscribe("RELATIONSHIP_ADD", onRelationshipAdd);
        delete Constants.FriendsSections[SECTION];
    }
});
