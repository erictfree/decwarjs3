// bot.ts — simple role-aware AI pilots for NPC ships

import { Player } from "../player.js";
import { Planet } from "../planet.js";
import { bases, planets, players } from "../game.js";
import { settings } from "../settings.js";
import { chebyshev } from "../coords.js";
import { addPendingMessage } from "../communication.js";
import { applyPhaserDamage } from "../phaser.js";
import { torpedoDamage } from "../torpedo.js";

export type BotRole = "aggressor" | "defender" | "raider";

/** lightweight state stored on the Player (no `any`) */
type BotState = Readonly<{
    botRole: BotRole;
    nextPhaserAt: number;
    nextTorpAt: number;
}>;

type Target =
    | { kind: "ship"; player: Player; distance: number }
    | { kind: "base"; planet: Planet; distance: number }
    | { kind: "planet"; planet: Planet; distance: number };

const SEARCH_RANGE = 20;
const PHA_PHIT = 0.4;            // parity with PHACON-scaled value
const PHA_COOLDOWN_MS = 750;     // scaled by active count below
const TORP_COOLDOWN_MS = 1000;   // scaled by active count below

// ----- tiny util: FORTRAN-like dice (1..n) -----
function iran(n: number): number {
    return Math.floor(Math.random() * n) + 1;
}

// ----- attach & query bot state safely (no `any`) -----
const BOT_KEY = Symbol("botState");
declare module "../player.js" {
    interface Player {
        // hidden symbol property
        [BOT_KEY]?: BotState;
    }
}

function setBotState(p: Player, s: BotState): void {
    p[BOT_KEY] = s;
}

function getBotState(p: Player): BotState | undefined {
    return p[BOT_KEY];
}

// public: mark a player as a bot with a specific role
export function registerBot(player: Player, role: BotRole): void {
    const now = Date.now();
    setBotState(player, {
        botRole: role,
        nextPhaserAt: now,
        nextTorpAt: now,
    });
}

// public: convenience to create a bot out of an existing Player
export function makeAggressorBot(player: Player): void {
    registerBot(player, "aggressor");
}
export function makeDefenderBot(player: Player): void {
    registerBot(player, "defender");
}
export function makeRaiderBot(player: Player): void {
    registerBot(player, "raider");
}

// ----- role helpers -----
function weaponPreferenceForRole(role: BotRole): "phaser" | "torpedo" | "mixed" {
    if (role === "aggressor") return "torpedo";
    if (role === "defender") return "phaser";
    return "mixed"; // raider
}

function stepForRole(role: BotRole): number {
    if (role === "aggressor") return 4;
    if (role === "defender") return 2;
    return 3; // raider
}

function basePauseScale(): number {
    const active = players.filter(p => p.ship && p.ship.energy > 0).length;
    return Math.max(1, active + 1);
}

// ----- main tick for all bots -----
export function updateBots(): void {
    //console.log("updateBots");
    if (!settings.generated) return;
    //console.log("updateBots2");

    const now = Date.now();

    for (const p of players) {
        if (!p.ship) continue;
        const state = getBotState(p);
        if (!state) continue; // not a bot

        // 1) choose target in range
        const target = chooseTarget(p);
        if (!target) continue;

        // 2) movement: close distance (don’t enter target tile)
        const tpos =
            target.kind === "ship"
                ? (target.player.ship ? target.player.ship.position : null)
                : target.planet.position;
        if (tpos) moveToward(p, tpos, stepForRole(state.botRole));

        // 3) weapon selection: role + context
        const pref = weaponPreferenceForRole(state.botRole);
        const preferTorp =
            pref === "torpedo"
                ? Math.random() < 0.75
                : pref === "phaser"
                    ? Math.random() < 0.25
                    : target.kind === "ship"
                        ? Math.random() < 0.6
                        : Math.random() < 0.4;

        const canPhaser = now >= state.nextPhaserAt;
        const canTorp = now >= state.nextTorpAt;

        // fallback: pick whatever is ready
        let useTorpedo = preferTorp ? canTorp || !canPhaser : false;
        if (!preferTorp) {
            useTorpedo = canTorp && !canPhaser ? true : false;
        }
        // if neither available, skip this tick
        if (!canPhaser && !canTorp) continue;

        // 4) fire
        if (useTorpedo && canTorp) {
            fireBotTorpedo(p, target);
            const next = now + basePauseScale() * TORP_COOLDOWN_MS;
            setBotState(p, { ...state, nextTorpAt: next });
        } else if (canPhaser) {
            fireBotPhaser(p, target);
            const next = now + basePauseScale() * PHA_COOLDOWN_MS;
            setBotState(p, { ...state, nextPhaserAt: next });
        }
    }
}

// ----- target selection (role-aware weighting) -----
function chooseTarget(bot: Player): Target | null {
    if (!bot.ship) return null;
    const me = bot.ship;

    const enemySides: ReadonlyArray<typeof me.side> =
        me.side === "FEDERATION" ? ["EMPIRE"]
            : me.side === "EMPIRE" ? ["FEDERATION"]
                : ["FEDERATION", "EMPIRE"]; // neutral/romulan -> both

    const bpos = me.position;
    const candidates: Target[] = [];

    // enemy ships
    for (const p of players) {
        if (!p.ship || p === bot) continue;
        if (!enemySides.includes(p.ship.side)) continue;
        const d = chebyshev(p.ship.position, bpos);
        if (d <= SEARCH_RANGE) candidates.push({ kind: "ship", player: p, distance: d });
    }

    // enemy bases
    for (const side of enemySides) {
        const list = side === "FEDERATION" ? bases.federation : bases.empire;
        for (const base of list) {
            const d = chebyshev(base.position, bpos);
            if (d <= SEARCH_RANGE) candidates.push({ kind: "base", planet: base, distance: d });
        }
    }

    // enemy planets (non-bases)
    for (const pl of planets) {
        if (pl.isBase) continue;
        if (!enemySides.includes(pl.side)) continue;
        const d = chebyshev(pl.position, bpos);
        if (d <= SEARCH_RANGE) candidates.push({ kind: "planet", planet: pl, distance: d });
    }

    if (candidates.length === 0) return null;

    const role = getBotState(bot)?.botRole ?? "aggressor";

    const weight = (t: Target): number => {
        switch (role) {
            case "aggressor":
                return t.kind === "ship" ? 1.0 : t.kind === "base" ? 0.7 : 0.4;
            case "defender": {
                // prefer enemies close to our own bases
                if (t.kind === "ship" && t.player.ship) {
                    const nb = nearestFriendlyBase(bot, t.player.ship.position);
                    const dToBase = nb ? chebyshev(t.player.ship.position, nb.position) : 99;
                    return 1.0 + (20 - Math.min(20, dToBase)) * 0.03;
                }
                return t.kind === "base" ? 0.6 : 0.4;
            }
            case "raider":
                return t.kind === "base" ? 1.0 : t.kind === "planet" ? 0.9 : 0.5;
        }
    };

    candidates.sort((a, b) => {
        const wdiff = weight(b) - weight(a);
        if (wdiff !== 0) return wdiff;          // higher weight first
        return a.distance - b.distance;         // then nearest
    });

    return candidates[0] ?? null;
}

function nearestFriendlyBase(bot: Player, pos: { v: number; h: number }): Planet | null {
    const side = bot.ship?.side ?? "NEUTRAL";
    const list = side === "FEDERATION" ? bases.federation : side === "EMPIRE" ? bases.empire : [];
    let best: Planet | null = null;
    let bestD = Number.MAX_SAFE_INTEGER;
    for (const b of list) {
        const d = chebyshev(b.position, pos);
        if (d < bestD) { best = b; bestD = d; }
    }
    return best;
}

// ----- movement (grid steps; don’t enter target tile) -----
function moveToward(bot: Player, dest: { v: number; h: number }, maxSteps: number): void {
    if (!bot.ship) return;

    const from = bot.ship.position;
    const dv = dest.v - from.v;
    const dh = dest.h - from.h;
    const dist = Math.max(Math.abs(dv), Math.abs(dh));
    if (dist <= 1) return; // already adjacent, don’t move

    const steps = Math.min(maxSteps, Math.max(0, dist - 1));
    const sv = Math.sign(dv);
    const sh = Math.sign(dh);

    const diag = Math.min(steps, Math.min(Math.abs(dv), Math.abs(dh)));
    const rem = steps - diag;

    const extraV = Math.min(rem, Math.max(0, Math.abs(dv) - diag));
    const extraH = Math.min(rem, Math.max(0, Math.abs(dh) - diag));

    const v = from.v + sv * (diag + extraV);
    const h = from.h + sh * (diag + extraH);

    bot.ship.position = { v, h };
}

// ----- weapons -----
function fireBotPhaser(bot: Player, target: Target): void {
    if (!bot.ship) return;

    const tgt: Player | Planet =
        target.kind === "ship" ? target.player :
            target.kind === "base" ? target.planet :
                target.planet;

    const res = applyPhaserDamage(bot, tgt, PHA_PHIT);

    if (target.kind === "ship") {
        addPendingMessage(target.player, `${bot.ship.name} hits you with phasers for ${Math.round(res.hita)}.`);
    }
}

function fireBotTorpedo(bot: Player, target: Target): void {
    if (!bot.ship) return;

    if (target.kind === "ship") {
        torpedoDamage(bot, target.player);
    } else {
        torpedoDamage(bot, target.planet);
    }
}

// ----- optional speaking flavor -----
export function botChatterTick(): void {
    // very lightweight: a couple times per sweep
    for (const p of players) {
        const st = getBotState(p);
        if (!st || !p.ship) continue;
        if (iran(20) !== 1) continue;

        const line =
            st.botRole === "aggressor"
                ? "Target acquired. Moving to engage."
                : st.botRole === "defender"
                    ? "Holding defensive perimeter."
                    : "Hunting logistics targets.";

        addPendingMessage(p, `${p.ship.name}: ${line}`);
    }
}
