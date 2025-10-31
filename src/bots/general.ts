// src/bots/general.ts
// Command-line bot: composes player commands and queues them via the dispatcher.

import { Player } from "../player.js";
import { NullSocket } from "../util/nullsocket.js";
import { GRID_HEIGHT, GRID_WIDTH, MAX_SHIELD_ENERGY } from "../settings.js";
import { players, bases, planets, stars, pointsManager } from "../game.js"; // +stars for strategy mapping
import { ran, iran } from "../util/random.js";
import { getAvailableShips } from "../pregame.js";
import { Planet } from "../planet.js";
import { chebyshev, findEmptyLocation } from "../coords.js";
import { queueCommands } from "../command.js"; // <- all actions go through here
import { emitShipJoined } from "../api/events.js";

// ===== Tuning ===============================================================
type Side = "FEDERATION" | "EMPIRE";

const KRANGE = 20;             // nearby dynamic threats (Chebyshev)
const STRATEGY_SCAN_RADIUS = 10; // "10 sector rule" for planning
const CLOSE_RANGE = 6;         // inside this, start firing
const DESIRED_COMBAT_RANGE = 4; // try to hover around this phaser-friendly spacing
const RETREAT_SHIELD_PCT = 0.12; // retreat when shields under 12% and outgunned
const RETREAT_ENERGY_ABS = 800;  // or when very low on energy and outgunned
const MOVE_MAX_STEP = 5;       // cap each MOVE to Chebyshev <= 5
const PHA_COOLDOWN_MS = 1200;
const TORP_COOLDOWN_MS = 2000;
const FIRE_BIAS = 0.55;        // prefer phasers when both ready

// Sensor/intel tuning
const SENSOR_RANGE = KRANGE;          // use same Chebyshev range as combat scan
// Randomized cadence: gate by chance, then enforce cooldown + hard gap.
const INTEL_COOLDOWN_MS = 25000;      // base min gap between enemy reports per bot
const INTEL_HARD_MIN_GAP_MS = 45000;  // absolute minimum separation between intel sends per bot
const INTEL_DEDUPE_TTL_MS = 60000;    // if signature unchanged within this window, suppress
const INTEL_CHANCE_BASE = 0.01;       // ~1% chance to report when quiet
const INTEL_CHANCE_ACTIVE = 0.01;     // ~1% even when near a fight (kept deliberately low)

// Active scan pacing (keeps team memory warm even if bots ignore output)
const SCAN_COOLDOWN_MS = 12000;       // at most one SCAN every ~12s per bot

// Repairs/build triggers
const SHIELD_LOW_PCT = 0.25;   // dock if shields < 25%
const ENERGY_LOW_ABS = 1200;   // dock if ship energy < 1200
const DAMAGE_HIGH_ABS = 300;   // dock if damage >= 300

// Build rules
const MAX_BASES_PER_SIDE = 10; // per requirement
const BUILD_COOLDOWN_MS = 2500;

// Activeness rules
const IDLE_MOVE_AFTER_MS = 4000; // if no movement in 4s, jitter
// ==========================================================================

// ===== Minimal shapes (avoid cross-module type coupling) ====================
type Vec2 = { v: number; h: number };
type Star = { position: Vec2 } | { pos?: Vec2 } | Record<string, unknown>;

// ===== Utilities ============================================================
const posKey = (p: Vec2) => `${p.v},${p.h}`;

function nearestBy<T>(from: Vec2, items: T[], getPos: (x: T) => Vec2): T | null {
    let best: { it: T; d: number } | null = null;
    for (const it of items) {
        const d = chebyshev(getPos(it), from);
        if (!best || d < best.d) best = { it, d };
    }
    return best?.it ?? null;
}

// Type guard: narrow any ship side to team sides only
function isTeamSide(s: unknown): s is Side {
    return s === "FEDERATION" || s === "EMPIRE";
}

// ===== Shared Team Memory ===================================================
//
// One shared memory per side that all bots on that team can read/write.
//
type Role = "HUNTER" | "BUILDER" | "DEFENDER";

interface TeamMemory {
    claimedNeutrals: Map<string, string>; // posKey -> shipName
    claimedBuilds: Map<string, string>;   // posKey -> shipName
    roles: Map<string, Role>;             // shipName -> role
    explored: Set<string>;                // posKey
    claimStamps: Map<string, number>;     // posKey -> last refresh
}

const teamMem: Record<Side, TeamMemory> = {
    FEDERATION: {
        claimedNeutrals: new Map(),
        claimedBuilds: new Map(),
        roles: new Map(),
        explored: new Set(),
        claimStamps: new Map(),
    },
    EMPIRE: {
        claimedNeutrals: new Map(),
        claimedBuilds: new Map(),
        roles: new Map(),
        explored: new Set(),
        claimStamps: new Map(),
    },
};

function gcTeamMem(mem: TeamMemory, ttlMs = 30000): void {
    const now = Date.now();
    for (const [k, t] of mem.claimStamps) {
        if (now - t > ttlMs) {
            mem.claimStamps.delete(k);
            mem.claimedNeutrals.delete(k);
            mem.claimedBuilds.delete(k);
        }
    }
}

// ===== Per-bot cooldowns & heartbeats ======================================
const phaUntil = new WeakMap<Player, number>();
const torpUntil = new WeakMap<Player, number>();
const nextChatterAt = new WeakMap<Player, number>(); // chatter rate-limiter
const nextBuildAt = new WeakMap<Player, number>();    // build rate-limiter
const lastMoveAt = new WeakMap<Player, number>();     // for idle nudge
const lastActionAt = new WeakMap<Player, number>();   // any action
const nextIntelAt = new WeakMap<Player, number>();    // intel rate-limiter
const lastIntelSig = new WeakMap<Player, string>();   // dedupe payloads
const nextSpiritAt = new WeakMap<Player, number>();   // morale chatter pacing

// ===== Persistent goal per bot =============================================
type Goal =
    | { kind: "neutral_planet"; planet: Planet }      // march to neutral and capture/kill
    | { kind: "build"; planet: Planet }               // march to owned world to build
    | { kind: "repair"; planet: Planet }              // march to friendly port
    | { kind: "defend"; position: Vec2 };             // move to a local defend point

const goalMap = new WeakMap<Player, Goal>();

function setGoal(bot: Player, goal: Goal | null): void {
    if (goal) goalMap.set(bot, goal); else goalMap.delete(bot);
}
function getGoal(bot: Player): Goal | null {
    return goalMap.get(bot) ?? null;
}
function goalIsValid(bot: Player, goal: Goal | null): boolean {
    if (!goal) return false;
    if (goal.kind === "neutral_planet") {
        if (!planets.includes(goal.planet)) return false;
        if (goal.planet.side !== "NEUTRAL") return false;
    } else if (goal.kind === "build") {
        if (!planets.includes(goal.planet)) return false;
        if ((goal.planet as unknown as { isBase?: boolean }).isBase) return false;
        if (goal.planet.side !== bot.ship!.side) return false;
    } else if (goal.kind === "repair") {
        if (!planets.includes(goal.planet)) return false;
        if (goal.planet.side !== bot.ship!.side) return false;
    }
    return true;
}

function stampMove(bot: Player): void {
    const now = Date.now();
    lastMoveAt.set(bot, now);
    lastActionAt.set(bot, now);
}
function stampAction(bot: Player): void {
    lastActionAt.set(bot, Date.now());
}

function tagAsBot(p: Player): void {
    (p as unknown as { __cmdBot: boolean }).__cmdBot = true;
    if (p.ship) p.ship.romulanStatus = { isRomulan: false, isRevealed: true, cloaked: false };
    const now = Date.now();
    phaUntil.set(p, now + 500);
    torpUntil.set(p, now + 1000);
    nextChatterAt.set(p, now + 3000);
    nextBuildAt.set(p, now + 1000);
    nextIntelAt.set(p, now + 1500);
    lastIntelSig.set(p, "");
    lastMoveAt.set(p, 0);
    lastActionAt.set(p, 0);
    setGoal(p, null);
}

// ===== Public helpers =======================================================
export function isBotPlayer(p: Player): boolean {
    if ((p as unknown as { __cmdBot?: boolean }).__cmdBot === true) return true;
    const n = p.settings.name ?? "";
    return /^BOT-/.test(n);
}

export function spawnSideBot(side: Side, name = `BOT-${side[0]}${iran(1000)}`): Player | null {
    // Abort early if no ship names are available for this side.
    const available = getAvailableShips(side);
    if (available.length === 0) return null;

    const pl = new Player(new NullSocket());
    pl.settings.name = name;
    (pl.settings as Record<string, unknown>).location = "virtual";
    (pl.settings as Record<string, unknown>).ip = "virtual";
    (pl.settings as Record<string, unknown>).userAgent = "virtual-bot";
    if (!pl.ship) return null;

    pl.ship.side = side;
    pl.ship.romulanStatus = { isRomulan: false, isRevealed: true, cloaked: false };
    pl.ship.energy = 5000;
    pl.ship.shieldEnergy = 500;
    pl.ship.damage = 0;

    // Assign a real, unused ship name, chosen at random from the available list.
    if (!pl.ship.name || /^NEUTRAL$/i.test(pl.ship.name)) {
        const pick = available[iran(available.length)];
        pl.ship.name = pick;
    }

    const pos = findEmptyLocation();
    if (!pos) return null;
    pl.ship.position = pos;

    // Mirror human onboarding so bots appear in POINTS/ALL and dashboards
    if (pl.ship.side === "FEDERATION" || pl.ship.side === "EMPIRE") {
        pointsManager.incrementShipsCommissioned(pl.ship.side);
    }
    players.push(pl);
    emitShipJoined(pl, "launch");
    tagAsBot(pl);
    return pl;
}

// Keep a global pool of N bots alive, alternating sides for balance.
export function ensureBots(desiredTotal: number): void {
    const live = players.filter(p => p.ship && isBotPlayer(p));
    let need = desiredTotal - live.length;
    if (need <= 0) return;

    // Track counts live and as we spawn.
    let fed = players.filter(p => p.ship && isBotPlayer(p) && p.ship!.side === "FEDERATION").length;
    let emp = players.filter(p => p.ship && isBotPlayer(p) && p.ship!.side === "EMPIRE").length;

    // Try to spawn until we reach desiredTotal or run out of ship names.
    while (need > 0) {
        // Prioritize the side with fewer bots (balance), then randomize if equal.
        let targetSide: Side;
        if (fed < emp) targetSide = "FEDERATION";
        else if (emp < fed) targetSide = "EMPIRE";
        else targetSide = ran() < 0.5 ? "FEDERATION" : "EMPIRE";

        const order: Side[] = [targetSide, targetSide === "FEDERATION" ? "EMPIRE" : "FEDERATION"];
        let spawned = false;

        for (const side of order) {
            if (getAvailableShips(side).length === 0) continue;

            const name = `BOT-${side[0]}${iran(10000)}`;
            const p = spawnSideBot(side, name);
            if (p && p.ship) {
                if (side === "FEDERATION") fed++; else emp++;
                need--;
                spawned = true;
                break; // one at a time
            }
        }
        if (!spawned) break;
    }
}

// Drive every bot each sweep
export function updateSideBots(): void {
    // GC old claims occasionally
    gcTeamMem(teamMem.FEDERATION);
    gcTeamMem(teamMem.EMPIRE);

    for (const bot of players) {
        if (!bot.ship) continue;
        if (!isBotPlayer(bot)) continue;

        // Write local intel into team memory
        senseAndShare(bot);

        driveBot(bot);

        // Broadcast intel to own side when we see something meaningful.
        // (Rate-limited & de-duplicated inside.)
        maybeIntelBroadcast(bot);

        // Light, rare morale chatter to own side
        maybeTeamSpirit(bot);

        // Idle nudge: guarantee visible activity even if higher-level goals fail
        const lm = lastMoveAt.get(bot) ?? 0;
        if (Date.now() - lm > IDLE_MOVE_AFTER_MS) {
            randomWander(bot);
        }
    }
}

// ===== Sensing & Team Memory ===============================================
function senseAndShare(bot: Player): void {
    if (!bot.ship) return;
    const shipSide = bot.ship.side;
    if (!isTeamSide(shipSide)) return; // don't index team memory with NEUTRAL, etc.

    const mem = teamMem[shipSide];
    const here = bot.ship.position;

    // Keep explored set bounded to a radius (10 sector rule for planning intel)
    for (const pl of planets) {
        if (chebyshev(pl.position, here) <= STRATEGY_SCAN_RADIUS) {
            mem.explored.add(posKey(pl.position));
        }
    }
    // Stars are just marked as explored (useful for “terrain”)
    const starList: Star[] = Array.isArray(stars) ? (stars as Star[]) : [];
    for (const st of starList) {
        const p: Vec2 | undefined = (st as { position?: Vec2; pos?: Vec2 }).position ?? (st as { pos?: Vec2 }).pos;
        if (!p) continue;
        if (chebyshev(p, here) <= STRATEGY_SCAN_RADIUS) mem.explored.add(posKey(p));
    }
    // Refresh our existing claims so they don't GC
    const now = Date.now();
    for (const [k, owner] of mem.claimedNeutrals) {
        if (owner === bot.ship.name) mem.claimStamps.set(k, now);
    }
    for (const [k, owner] of mem.claimedBuilds) {
        if (owner === bot.ship.name) mem.claimStamps.set(k, now);
    }
    // Assign a role if none
    if (!mem.roles.has(bot.ship.name!)) {
        const r: Role = ran() < 0.33 ? "BUILDER" : "HUNTER";
        mem.roles.set(bot.ship.name!, r);
    }
}

// ===== Core AI ==============================================================
type Target =
    | { kind: "ship"; player: Player; distance: number }
    | { kind: "base"; planet: Planet; distance: number }
    | { kind: "planet"; planet: Planet; distance: number }; // NEUTRAL or enemy planet

function driveBot(bot: Player): void {
    if (!bot.ship) return;

    maybeChatter(bot);

    const shipSide = bot.ship.side;
    if (!isTeamSide(shipSide)) { randomWander(bot); return; } // safety

    const mem = teamMem[shipSide];

    // 0) Repairs first (with persistent repair goal)
    if (needsRepair(bot)) {
        let g = getGoal(bot);
        if (!goalIsValid(bot, g) || g?.kind !== "repair") {
            const port = findNearestFriendlyPort(bot);
            if (port) setGoal(bot, { kind: "repair", planet: port });
        }
        g = getGoal(bot);
        if (g && g.kind === "repair") {
            const dist = chebyshev(bot.ship.position, g.planet.position);
            if (dist > 1) { moveToward(bot, g.planet.position); return; }
            queueCommands(bot, "DOCK");
            stampAction(bot);
            return;
        }
        randomWander(bot); // no port found
        return;
    } else {
        const g = getGoal(bot);
        if (g?.kind === "repair") setGoal(bot, null);
        queueCommands(bot, "UNDOCK"); // safe no-op if undocked
        stampAction(bot);
    }

    // 1) Role-based strategic objective inside 10-sector scan
    const role = mem.roles.get(bot.ship.name!) ?? "HUNTER";

    if (role === "BUILDER" && teamCanBuildMore(bot)) {
        // Try to claim an owned non-base planet within the scan radius
        const owned = planets.filter(p =>
            p.side === shipSide &&
            !(p as unknown as { isBase?: boolean }).isBase &&
            chebyshev(p.position, bot.ship!.position) <= STRATEGY_SCAN_RADIUS
        );
        // Skip ones already claimed by teammates
        const candidates = owned.filter(p => mem.claimedBuilds.get(posKey(p.position)) === undefined);
        let g = getGoal(bot);
        if (!goalIsValid(bot, g) || g?.kind !== "build") {
            const pick = nearestBy(bot.ship.position, candidates, x => x.position)
                ?? nearestBy(bot.ship.position, owned, x => x.position);
            if (pick) {
                setGoal(bot, { kind: "build", planet: pick });
                const key = posKey(pick.position);
                mem.claimedBuilds.set(key, bot.ship.name!);
                mem.claimStamps.set(key, Date.now());
            }
        }
        g = getGoal(bot);
        if (g && g.kind === "build") {
            const dist = chebyshev(bot.ship.position, g.planet.position);
            if (dist > 1) { moveToward(bot, g.planet.position); return; }
            const now = Date.now();
            const notBefore = nextBuildAt.get(bot) ?? 0;
            if (now >= notBefore) {
                queueCommands(bot, `BUILD A ${g.planet.position.v} ${g.planet.position.h}`);
                nextBuildAt.set(bot, now + BUILD_COOLDOWN_MS);
                stampAction(bot);
            }
            return;
        }
        // If build not possible, fall through to hunting
    }

    // 2) Dynamic nearby threats (always allowed if within KRANGE)
    const nearby = findClosestTarget(bot);
    if (nearby) {
        const tpos = nearby.kind === "ship" ? nearby.player.ship!.position : nearby.planet.position;
        const dist = chebyshev(bot.ship.position, tpos);

        if (nearby.kind === "planet" && nearby.planet.side === "NEUTRAL" && dist <= 1) {
            queueCommands(bot, `CAPTURE A ${tpos.v} ${tpos.h}`);
            stampAction(bot);
            const key = posKey(tpos);
            if (mem.claimedNeutrals.get(key) === bot.ship.name) mem.claimedNeutrals.delete(key);
            return;
        }

        // Smarter spacing around targets (kiting / approach / retreat)
        if (dist !== DESIRED_COMBAT_RANGE) { smartCombatStep(bot, tpos, dist); }
        // If we moved for spacing, let the dispatcher pace weapons naturally
        if (dist > CLOSE_RANGE) { return; }

        const now = Date.now();
        const phaReady = now >= (phaUntil.get(bot) ?? 0);
        const torpReady = now >= (torpUntil.get(bot) ?? 0);
        if (!phaReady && !torpReady) return;

        if (phaReady && torpReady) {
            if (ran() < FIRE_BIAS) firePhasers(bot, nearby);
            else fireTorpedo(bot, nearby);
        } else if (phaReady) {
            firePhasers(bot, nearby);
        } else {
            fireTorpedo(bot, nearby);
        }
        // Light focus-fire ping (very occasional) to our side when engaging a ship
        if (nearby.kind === "ship" && isTeamSide(bot.ship.side) && ran() < 0.15) {
            const name = nearby.player.ship!.name ?? "target";
            queueCommands(bot, `TELL ${bot.ship.side}; Firing on ${name} at ${tpos.v} ${tpos.h} — focus?`);
        }
        return;
    }

    // 3) Strategic hunting of neutrals using shared claims (within 10 sectors)
    {
        const here = bot.ship.position;
        // Unclaimed neutrals inside scan radius
        const localNeutrals = planets.filter(p =>
            p.side === "NEUTRAL" &&
            chebyshev(p.position, here) <= STRATEGY_SCAN_RADIUS
        );
        const freeNeutrals = localNeutrals.filter(p => mem.claimedNeutrals.get(posKey(p.position)) === undefined);

        let g = getGoal(bot);
        if (!goalIsValid(bot, g) || g?.kind !== "neutral_planet") {
            const pick = nearestBy(here, freeNeutrals, x => x.position)
                ?? nearestBy(here, localNeutrals, x => x.position);
            if (pick) {
                setGoal(bot, { kind: "neutral_planet", planet: pick });
                const key = posKey(pick.position);
                mem.claimedNeutrals.set(key, bot.ship.name!);
                mem.claimStamps.set(key, Date.now());
            }
        }

        g = getGoal(bot);
        if (g && g.kind === "neutral_planet") {
            const dist = chebyshev(here, g.planet.position);
            if (dist > 1) { moveToward(bot, g.planet.position); return; }
            queueCommands(bot, `CAPTURE A ${g.planet.position.v} ${g.planet.position.h}`);
            stampAction(bot);
            const key = posKey(g.planet.position);
            if (mem.claimedNeutrals.get(key) === bot.ship.name) mem.claimedNeutrals.delete(key);
            return;
        }
    }

    // 4) Fallback: if nothing in strategic radius, walk toward the *global* nearest neutral
    {
        const np = findNearestNeutralPlanetGlobal(bot);
        if (np) {
            const dist = chebyshev(bot.ship.position, np.position);
            if (dist > 1) { moveToward(bot, np.position); return; }
            queueCommands(bot, `CAPTURE A ${np.position.v} ${np.position.h}`);
            stampAction(bot);
            return;
        }
    }

    // 5) Nothing to do — wander
    randomWander(bot);
}

// Prefer enemy ships, then enemy bases, then neutral planets (nearby only)
function findClosestTarget(bot: Player): Target | null {
    if (!bot.ship) return null;
    const pos = bot.ship.position;
    const enemySide: Side = bot.ship.side === "FEDERATION" ? "EMPIRE" : "FEDERATION";

    let best: Target | null = null;

    // Enemy ships
    for (const p of players) {
        if (!p.ship || p === bot) continue;
        if (p.ship.side !== enemySide) continue;
        const d = chebyshev(p.ship.position, pos);
        if (d > KRANGE) continue;
        if (!best || d < best.distance) best = { kind: "ship", player: p, distance: d };
    }

    // Enemy bases
    const baseList = enemySide === "FEDERATION" ? bases.federation : bases.empire;
    for (const base of baseList) {
        const d = chebyshev(base.position, pos);
        if (d > KRANGE) continue;
        if (!best || d < best.distance) best = { kind: "base", planet: base, distance: d };
    }

    // Neutral planets (opportunistic nearby caps)
    for (const pl of planets) {
        if (pl.side !== "NEUTRAL") continue;
        const d = chebyshev(pl.position, pos);
        if (d > KRANGE) continue;
        if (!best || d < best.distance) best = { kind: "planet", planet: pl, distance: d };
    }

    return best;
}

// ===== Intel broadcasting ===================================================
function contactSig(bot: Player, enemySide: Side): string {
    const here = bot.ship!.position;

    const eShips = players.filter(p =>
        p !== bot &&
        p.ship &&
        p.ship.side === enemySide &&
        chebyshev(p.ship.position, here) <= SENSOR_RANGE
    );

    const ePlanets = planets.filter(pl =>
        pl.side === enemySide &&
        chebyshev(pl.position, here) <= SENSOR_RANGE
    );

    const eBases = (enemySide === "FEDERATION" ? bases.federation : bases.empire)
        .filter(b => chebyshev(b.position, here) <= SENSOR_RANGE);

    const keyPos = (v: { v: number; h: number }) => `${v.v}:${v.h}`;
    const s1 = eShips.map(p => keyPos(p.ship!.position)).sort().join("|");
    const s2 = ePlanets.map(p => keyPos(p.position)).sort().join("|");
    const s3 = eBases.map(p => keyPos(p.position)).sort().join("|");
    return `S=${s1};P=${s2};B=${s3}`;
}

function maybeIntelBroadcast(bot: Player): void {
    if (!bot.ship) return;
    const sideAny = bot.ship.side;
    if (sideAny !== "FEDERATION" && sideAny !== "EMPIRE") return;

    const now = Date.now();
    const notBefore = nextIntelAt.get(bot) ?? 0;
    if (now < notBefore) return;

    const here = bot.ship.position;
    const enemySide: Side = sideAny === "FEDERATION" ? "EMPIRE" : "FEDERATION";

    const eShips = players
        .filter(p => p !== bot && p.ship && p.ship.side === enemySide)
        .map(p => ({ p, d: chebyshev(p.ship!.position, here) }))
        .filter(x => x.d <= SENSOR_RANGE)
        .sort((a, b) => a.d - b.d);

    const ePlanets = planets
        .filter(pl => pl.side === enemySide)
        .map(pl => ({ pl, d: chebyshev(pl.position, here) }))
        .filter(x => x.d <= SENSOR_RANGE)
        .sort((a, b) => a.d - b.d);

    const eBases = (enemySide === "FEDERATION" ? bases.federation : bases.empire)
        .map(pl => ({ pl, d: chebyshev(pl.position, here) }))
        .filter(x => x.d <= SENSOR_RANGE)
        .sort((a, b) => a.d - b.d);

    if (eShips.length === 0 && ePlanets.length === 0 && eBases.length === 0) {
        nextIntelAt.set(bot, now + 1500);
        return;
    }

    const sig = contactSig(bot, enemySide);
    if (sig === (lastIntelSig.get(bot) ?? "")) {
        nextIntelAt.set(bot, now + 1500);
        return;
    }
    lastIntelSig.set(bot, sig);

    // Conversational, one item only. Priority: ship > base > planet.
    const fmtPosDash = (v: { v: number; h: number }) => `${v.v}-${v.h}`;
    const fmtPosSp = (v: { v: number; h: number }) => `${v.v} ${v.h}`;
    let msg = "";
    if (eShips.length > 0) {
        const lead = eShips[0];
        const name = lead.p.ship!.name ?? "UNKNOWN";
        const lines = [
            `Found an enemy ship ${name} at ${fmtPosSp(lead.p.ship!.position)}!`,
            `${name} spotted at ${fmtPosSp(lead.p.ship!.position)} — eyes up.`,
            `Enemy ship ${name} at ${fmtPosSp(lead.p.ship!.position)}.`
        ];
        msg = lines[iran(lines.length)];
    } else if (eBases.length > 0) {
        const lead = eBases[0];
        const lines = [
            `Found an enemy base at ${fmtPosSp(lead.pl.position)}!`,
            `Enemy base located at ${fmtPosSp(lead.pl.position)}.`,
            `Hostile base at ${fmtPosSp(lead.pl.position)} — mark it.`
        ];
        msg = lines[iran(lines.length)];
    } else if (ePlanets.length > 0) {
        const lead = ePlanets[0];
        const lines = [
            `Found an enemy planet at ${fmtPosSp(lead.pl.position)}!`,
            `Enemy-held world at ${fmtPosSp(lead.pl.position)}.`,
            `Enemy planet at ${fmtPosSp(lead.pl.position)} — could be soft.`
        ];
        msg = lines[iran(lines.length)];
    } else {
        // Shouldn't reach here (we early-return if no contacts), but be safe.
        nextIntelAt.set(bot, now + 2500 + iran(1500));
        return;
    }
    queueCommands(bot, `TELL ${sideAny}; ${msg}`);

    // Adaptive randomized cooldown: add some jitter so bots don't sync up.
    const loadFactor = Math.min(6, eShips.length + ePlanets.length + eBases.length);
    const extra = Math.min(5000, loadFactor * 500);
    nextIntelAt.set(bot, now + INTEL_COOLDOWN_MS + extra + iran(4000));
}

// ===== Local threat model & combat movement =================================
function localEnemies(bot: Player): Array<{ pos: { v: number; h: number }; d: number; name: string }> {
    if (!bot.ship) return [];
    const pos = bot.ship.position;
    const enemySide: Side = bot.ship.side === "FEDERATION" ? "EMPIRE" : "FEDERATION";
    return players
        .filter(p => p.ship && p !== bot && p.ship.side === enemySide)
        .map(p => ({ pos: p.ship!.position, d: chebyshev(p.ship!.position, pos), name: p.ship!.name ?? "UNKNOWN" }))
        .filter(x => x.d <= KRANGE);
}

function threatScore(bot: Player): number {
    // Very simple: count enemies in rings with decaying weight.
    const es = localEnemies(bot);
    let score = 0;
    for (const e of es) {
        if (e.d <= 3) score += 1.0;
        else if (e.d <= 6) score += 0.5;
        else if (e.d <= 10) score += 0.25;
        else score += 0.1;
    }
    return score;
}

function ownStayingPower(bot: Player): number {
    if (!bot.ship) return 0;
    const sFrac = Math.max(0, Math.min(1, bot.ship.shieldEnergy / Math.max(1, MAX_SHIELD_ENERGY)));
    const eTerm = bot.ship.energy > 3000 ? 0.25 : bot.ship.energy > 1500 ? 0.15 : 0.05;
    return sFrac + eTerm; // roughly 0..1.25
}

function shouldRetreat(bot: Player): boolean {
    if (!bot.ship) return false;
    const shieldsLow = bot.ship.shieldEnergy < RETREAT_SHIELD_PCT * MAX_SHIELD_ENERGY;
    const energyLow = bot.ship.energy < RETREAT_ENERGY_ABS;
    const outgunned = threatScore(bot) > 1.25 + ownStayingPower(bot);
    return (shieldsLow || energyLow) && outgunned;
}

function moveAwayFrom(bot: Player, from: { v: number; h: number }): void {
    if (!bot.ship) return;
    const me = bot.ship.position;
    const dv = me.v - from.v;
    const dh = me.h - from.h;
    const [rv, rh] = clampChebyshev(dv, dh, MOVE_MAX_STEP);
    const toV = Math.max(1, Math.min(GRID_HEIGHT, me.v + rv));
    const toH = Math.max(1, Math.min(GRID_WIDTH, me.h + rh));
    const rvBound = toV - me.v;
    const rhBound = toH - me.h;
    if (rvBound !== 0 || rhBound !== 0) {
        queueCommands(bot, `MOVE R ${rvBound} ${rhBound}`);
        stampMove(bot);
    }
}

function smartCombatStep(bot: Player, tpos: { v: number; h: number }, dist: number): void {
    if (!bot.ship) return;
    if (shouldRetreat(bot)) { moveAwayFrom(bot, tpos); return; }
    if (dist < DESIRED_COMBAT_RANGE) { moveAwayFrom(bot, tpos); return; }
    if (dist > DESIRED_COMBAT_RANGE) { moveToward(bot, tpos); return; }
    // strafe
    const step = 1 + iran(Math.max(1, Math.min(MOVE_MAX_STEP - 1, 2)));
    const dv = iran(3) - 1; // -1..1
    const dh = (dv === 0) ? (ran() < 0.5 ? -step : step) : 0;
    const me = bot.ship.position;
    const toV = Math.max(1, Math.min(GRID_HEIGHT, me.v + dv));
    const toH = Math.max(1, Math.min(GRID_WIDTH, me.h + dh));
    const rv = toV - me.v, rh = toH - me.h;
    if (rv !== 0 || rh !== 0) { queueCommands(bot, `MOVE R ${rv} ${rh}`); stampMove(bot); }
}

// ===== Global objective helpers ============================================
function findNearestNeutralPlanetGlobal(bot: Player): Planet | null {
    if (!bot.ship) return null;
    const pos = bot.ship.position;
    let best: { pl: Planet; d: number } | null = null;
    for (const pl of planets) {
        if (pl.side !== "NEUTRAL") continue;
        const d = chebyshev(pl.position, pos);
        if (!best || d < best.d) best = { pl, d };
    }
    return best?.pl ?? null;
}

// ===== Repairs/building helpers ============================================

function needsRepair(bot: Player): boolean {
    const s = bot.ship!;
    const shieldLow = s.shieldEnergy < SHIELD_LOW_PCT * MAX_SHIELD_ENERGY;
    const energyLow = s.energy < ENERGY_LOW_ABS;
    const damageHigh = s.damage >= DAMAGE_HIGH_ABS;
    return shieldLow || energyLow || damageHigh;
}

function findNearestFriendlyPort(bot: Player): Planet | null {
    if (!bot.ship) return null;
    const shipSide = bot.ship.side;
    if (!isTeamSide(shipSide)) return null;
    const pos = bot.ship.position;

    // Prefer bases, then any friendly planet
    const friendlyBases = (shipSide === "FEDERATION" ? bases.federation : bases.empire) as Planet[];
    const friendlyPlanets = planets.filter(p => p.side === shipSide);
    const candidates: Planet[] = [...friendlyBases, ...friendlyPlanets];

    return nearestBy(pos, candidates, x => x.position);
}

function teamCanBuildMore(bot: Player): boolean {
    if (!bot.ship) return false;
    const shipSide = bot.ship.side;
    if (!isTeamSide(shipSide)) return false;
    const teamBases = shipSide === "FEDERATION" ? bases.federation : bases.empire;
    return teamBases.length < MAX_BASES_PER_SIDE;
}

// ===== Team-spirit chatter (own side only, ~5%) =============================
function maybeTeamSpirit(bot: Player): void {
    if (!bot.ship) return;
    const sideAny = bot.ship.side;
    if (sideAny !== "FEDERATION" && sideAny !== "EMPIRE") return; // only teams

    const now = Date.now();
    const notBefore = nextSpiritAt.get(bot) ?? 0;
    if (now < notBefore) return;

    // ~5% chance gate
    if (ran() > 0.05) {
        nextSpiritAt.set(bot, now + 3000 + iran(3000));
        return;
    }

    // Faction-appropriate morale lines (inspired by Romulan cadence, but toned)
    const msg = generateFactionSpirit(sideAny);
    queueCommands(bot, `TELL ${sideAny}; ${msg}`);

    // Independent cooldown so it doesn't collide with intel pacing
    const SPIRIT_COOLDOWN_MS = 14000; // fairly low cadence
    nextSpiritAt.set(bot, now + SPIRIT_COOLDOWN_MS + iran(4000));
}

// ===== Faction spirit line generator (50 each) ==============================
function generateFactionSpirit(side: Side): string {
    return side === "FEDERATION" ? fedSpiritLine() : kliSpiritLine();
}

function fedSpiritLine(): string {
    const L: readonly string[] = [
        "Steady as she goes.",
        "Keep formation tight and sensors up.",
        "Fly your plan; call your targets.",
        "Let’s solve this one cleanly.",
        "Maintain discipline—short bursts, smart moves.",
        "We’ve trained for this—execute.",
        "Mind your shield levels and share status.",
        "Good flying—keep it methodical.",
        "Stay focused; no heroics.",
        "We are stronger together—stay linked.",
        "Prioritize objectives, then threats.",
        "Hold your vectors; don’t drift.",
        "Clear comms—concise and calm.",
        "Rotate damage; cover your wing.",
        "Eyes open for civilians and friendlies.",
        "Minimal risk, maximal effect.",
        "Keep it professional—no loose fire.",
        "Confirm your locks before you shoot.",
        "We preserve life; take smart shots.",
        "Adapt and overcome—use the map.",
        "Report if you’re low on energy.",
        "If you need repairs, say so early.",
        "Nice work—keep that tempo.",
        "Let’s finish this by the book.",
        "Trust your instruments and your team.",
        "We learn, we adjust, we advance.",
        "Protect our bases—don’t overextend.",
        "Phasers for precision—torps for finish.",
        "Keep the initiative without rushing.",
        "We’re here to stabilize the sector.",
        "Tidy lanes, clean exits.",
        "Make the next move the right one.",
        "Hold your ground; the line is here.",
        "We act with purpose and clarity.",
        "Stay patient; opportunities open.",
        "Good discipline; keep it up.",
        "Cycle your shields—don’t let them crash.",
        "Share scans; confirm sightings.",
        "If you’re isolated, vector home.",
        "Secure the neutral worlds responsibly.",
        "We measure twice and cut once.",
        "Small risks, big results.",
        "Don’t chase—guide them into our net.",
        "Mission first, ego last.",
        "We look out for each other.",
        "Keep the corridor clear.",
        "Form up on the anchor ship.",
        "Calm hands win fights.",
        "We’re the example—let’s show it.",
        "Finish strong, then regroup.",
        "Federation crew—let’s bring them home."
    ] as const;
    return L[iran(L.length)];
}

function kliSpiritLine(): string {
    const L: readonly string[] = [
        "Glory to the Empire!",
        "Steel your heart and strike.",
        "Honor in the hunt—stay with your pack.",
        "Let them fear our silhouettes.",
        "Raise your shields, then break theirs.",
        "A clean kill brings great honor.",
        "Hold the line; their courage will fail.",
        "Our torpedoes speak for us.",
        "Harden your will; soften theirs.",
        "We fight together or not at all.",
        "Choose the strongest foe and test them.",
        "No waste—every shot a promise.",
        "Drive them from our stars.",
        "A swift victory sings loudest.",
        "Turn your damage into resolve.",
        "Do not drift—press with purpose.",
        "The wise warrior keeps reserves.",
        "Circle and cut—deny them breath.",
        "Take their base; take their spirit.",
        "Our shields are our banner—hold them high.",
        "Strike once, strike true.",
        "Hunt as one; feed as one.",
        "Give them a reason to run.",
        "We were born for this sky.",
        "Pin them; let the pack finish.",
        "Spare no thrust—finish the chase.",
        "Let our names be carried forward.",
        "The patient blade cuts deeper.",
        "A worthy foe sharpens us.",
        "Our formation is a hammer.",
        "Break their courage, then their hull.",
        "Answer insult with precision.",
        "Bring them to heel.",
        "Even damaged, a warrior strikes.",
        "Do not overreach—strike again.",
        "The Empire watches; do it well.",
        "They will remember this day.",
        "Hunt the weak, bind the strong.",
        "We are the storm they feared.",
        "Honor is the last word spoken.",
        "Cut the head; the tail flees.",
        "Tighten the net—no escape.",
        "Feed the fire with victory.",
        "We claim these stars by deed.",
        "Make your ancestors proud.",
        "We do not falter.",
        "Let them see our resolve.",
        "One pack, one purpose.",
        "Strike hard, then vanish.",
        "Klingons—forward!"
    ] as const;
    return L[iran(L.length)];
}

// ===== Helper: clamp a relative vector to Chebyshev <= maxStep ==============
function clampChebyshev(dv: number, dh: number, maxStep = MOVE_MAX_STEP): [number, number] {
    const mag = Math.max(Math.abs(dv), Math.abs(dh));
    if (mag <= maxStep) return [dv, dh];
    const scale = maxStep / mag;
    // round toward zero to avoid overshoot; ensure not both zero
    let rv = Math.trunc(dv * scale);
    let rh = Math.trunc(dh * scale);
    if (rv === 0 && dv !== 0) rv = Math.sign(dv);
    if (rh === 0 && dh !== 0) rh = Math.sign(dh);
    // after rounding, still guarantee Chebyshev <= maxStep
    const clamp = (n: number) => Math.max(-maxStep, Math.min(maxStep, n));
    rv = clamp(rv); rh = clamp(rh);
    return [rv, rh];
}

// ===== Issue real commands ==================================================

// Movement: use MOVE in RELATIVE mode; each command keeps Chebyshev <= 5.
function moveToward(bot: Player, targetPos: Vec2): void {
    if (!bot.ship) return;
    const from = bot.ship.position;
    const dv = targetPos.v - from.v;
    const dh = targetPos.h - from.h;

    const [rv, rh] = clampChebyshev(dv, dh, MOVE_MAX_STEP);

    // Bound to grid in case the command parser doesn’t; parser will also validate.
    const toV = Math.max(1, Math.min(GRID_HEIGHT, from.v + rv));
    const toH = Math.max(1, Math.min(GRID_WIDTH, from.h + rh));
    const rvBound = toV - from.v;
    const rhBound = toH - from.h;

    if (rvBound !== 0 || rhBound !== 0) {
        queueCommands(bot, `MOVE R ${rvBound} ${rhBound}`);
        stampMove(bot);
    }
}

function firePhasers(bot: Player, target: Target): void {
    if (!bot.ship) return;
    const from = bot.ship.position;
    const tpos = target.kind === "ship" ? target.player.ship!.position : target.planet.position;

    const rv = Math.max(-10, Math.min(10, tpos.v - from.v));
    const rh = Math.max(-10, Math.min(10, tpos.h - from.h));

    queueCommands(bot, `PH R ${rv} ${rh}`);
    phaUntil.set(bot, Date.now() + PHA_COOLDOWN_MS);
    stampAction(bot);
}

function fireTorpedo(bot: Player, target: Target): void {
    if (!bot.ship) return;
    const from = bot.ship.position;
    const tpos = target.kind === "ship" ? target.player.ship!.position : target.planet.position;

    const rv = tpos.v - from.v;
    const rh = tpos.h - from.h;

    queueCommands(bot, `TO R 1 ${rv} ${rh}`);
    torpUntil.set(bot, Date.now() + TORP_COOLDOWN_MS);
    stampAction(bot);
}

// ===== Fallback if no targets: small MOVE R jitter ==========================
function randomWander(bot: Player): void {
    if (!bot.ship) return;

    const step = 1 + iran(MOVE_MAX_STEP); // 1..5
    let dv = iran(2 * step + 1) - step;
    let dh = iran(2 * step + 1) - step;
    if (dv === 0 && dh === 0) dv = 1; // ensure some movement

    const from = bot.ship.position;
    const toV = Math.max(1, Math.min(GRID_HEIGHT, from.v + dv));
    const toH = Math.max(1, Math.min(GRID_WIDTH, from.h + dh));
    const rv = toV - from.v;
    const rh = toH - from.h;

    if (rv !== 0 || rh !== 0) {
        queueCommands(bot, `MOVE R ${rv} ${rh}`);
        stampMove(bot);
    }
}

// ===== Chatter (data-driven) ===============================================

function percent(n: number, d: number): number {
    if (d <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((n / d) * 100)));
}
function formatPos(p: { v: number; h: number }): string {
    return `${p.v}-${p.h}`;
}

function maybeChatter(bot: Player): void {
    if (!bot.ship) return;
    const now = Date.now();
    const notBefore = nextChatterAt.get(bot) ?? 0;
    if (now < notBefore) return;

    // ~2.7% base chance to talk; ~4.5% when actively engaging (15% of prior rates).
    const active = isActivelyEngaging(bot);
    const chance = active ? 0.045 : 0.027;
    if (ran() > chance) return;

    // pick audience: 60% SIDE, 25% ALL, 15% a single friendly ship
    const roll = ran();
    let audience: string = "ALL";
    if (roll < 0.60 && isTeamSide(bot.ship.side)) {
        audience = bot.ship.side;
    } else if (roll < 0.85) {
        audience = "ALL";
    } else {
        const friend = players.find(p => p !== bot && p.ship && p.ship.side === bot.ship!.side);
        audience = friend?.ship?.name ?? (isTeamSide(bot.ship.side) ? bot.ship.side : "ALL");
    }

    const line = generateChatterLine(bot);
    queueCommands(bot, `TELL ${audience}; ${line}`);

    // cooldown 6–12s, shorter when active
    nextChatterAt.set(bot, now + (active ? 6000 + iran(3000) : 8000 + iran(4000)));
}

function isActivelyEngaging(bot: Player): boolean {
    if (!bot.ship) return false;
    const t = findClosestTarget(bot);
    if (!t) return false;
    const tpos = t.kind === "ship" ? t.player.ship!.position : t.planet.position;
    const d = chebyshev(bot.ship.position, tpos);
    return d <= CLOSE_RANGE;
}

function generateChatterLine(bot: Player): string {
    if (!bot.ship) return "Standing by.";
    const s = bot.ship;
    const here = s.position;
    const shieldPct = percent(s.shieldEnergy, MAX_SHIELD_ENERGY);
    const role = isTeamSide(s.side) ? (teamMem[s.side].roles.get(s.name!) ?? "HUNTER") : "HUNTER";
    const goal = getGoal(bot);

    // 1) Critical/repair info (more conversational, space-separated coords)
    if (needsRepair(bot)) {
        const port = findNearestFriendlyPort(bot);
        const fmt = (p: { v: number; h: number }) => `${p.v} ${p.h}`;
        if (port) {
            const lines = [
                `Shields at ${shieldPct}%. Heading to dock at ${fmt(port.position)}.`,
                `Took some hits—${shieldPct}% shields. Going for repairs at ${fmt(port.position)}.`,
                `I’m banged up. Docking at ${fmt(port.position)}.`,
                `Low on shields (${shieldPct}%). Vectoring to ${fmt(port.position)} for repairs.`,
                `Need a pit stop—${shieldPct}% shields. Dock at ${fmt(port.position)}.`
            ];
            return lines[iran(lines.length)];
        }
        const lines = [
            `Shields at ${shieldPct}%. Looking for a place to dock.`,
            `Not pretty on my end—${shieldPct}% shields. Seeking repairs.`,
            `I’m a little cooked. Finding a dock now.`,
            `Could use a hand—shields ${shieldPct}%. Searching for repairs.`
        ];
        return lines[iran(lines.length)];
    }

    // 2) Goal-specific comms
    if (goal && goal.kind === "repair") {
        const fmt = (p: { v: number; h: number }) => `${p.v} ${p.h}`;
        const lines = [
            `On the way to dock at ${fmt(goal.planet.position)}.`,
            `Routing to ${fmt(goal.planet.position)} for repairs.`,
            `Setting down at ${fmt(goal.planet.position)} to patch up.`
        ];
        return lines[iran(lines.length)];
    }
    if (goal && goal.kind === "build") {
        const d = chebyshev(here, goal.planet.position);
        return `Builder ${s.name} en route to ${formatPos(goal.planet.position)} (∆=${d}) to lay down a base.`;
    }
    if (goal && goal.kind === "neutral_planet") {
        const d = chebyshev(here, goal.planet.position);
        if (d <= 1) return `On station at ${formatPos(goal.planet.position)} — commencing capture.`;
        return `Claiming neutral at ${formatPos(goal.planet.position)} (∆=${d}).`;
    }

    // 3) Local tactical picture (within KRANGE)
    const enemySide: Side = s.side === "FEDERATION" ? "EMPIRE" : "FEDERATION";
    const enemyShips = players.filter(p => p.ship && p.ship.side === enemySide);
    let seen = 0;
    let nearestEnemy: Player | null = null;
    let nearestD = Infinity;
    for (const e of enemyShips) {
        const d = chebyshev(e.ship!.position, here);
        if (d <= KRANGE) {
            seen++;
            if (d < nearestD) { nearestD = d; nearestEnemy = e; }
        }
    }
    if (seen > 0 && nearestEnemy) {
        const name = nearestEnemy.ship!.name ?? "enemy ship";
        const v = nearestEnemy.ship!.position.v;
        const h = nearestEnemy.ship!.position.h;
        const lines = [
            `Spotted ${name} at ${v} ${h}.`,
            `${name} at ${v} ${h} — moving careful.`,
            `Enemy contact: ${name} near ${v} ${h}.`
        ];
        return lines[iran(lines.length)];
    }

    // 4) Strategic summary nearby (within strategy radius)
    const neutralsNearby = planets.filter(p => p.side === "NEUTRAL" && chebyshev(p.position, here) <= STRATEGY_SCAN_RADIUS);
    if (neutralsNearby.length > 0) {
        const hereStr = `${here.v}-${here.h}`;
        const includePos = ran() < 0.2; // 20% chance to mention own position
        const lines = [
            "Neutral cluster ahead. Moving to engage.",
            "Neutral worlds detected. Moving in.",
            "Picking up neutrals nearby. Closing distance."
        ];
        let msg = lines[iran(lines.length)];
        if (includePos) msg += ` I'm at ${hereStr}.`;
        return msg;
    }

    // 5) Team/base posture
    const fedBases = bases.federation.length;
    const empBases = bases.empire.length;
    if (isTeamSide(s.side) && teamCanBuildMore(bot) && role === "BUILDER") {
        return `We have ${s.side === "FEDERATION" ? fedBases : empBases} base(s). Slot open—scouting a friendly world to build.`;
    }
    if (isTeamSide(s.side) && role === "HUNTER") {
        const allNeutrals = planets.filter(p => p.side === "NEUTRAL").length;
        return `Hunter on patrol — ${allNeutrals} neutral planet(s) remain. Sweep continues.`;
    }

    // 6) Occasional team-spirit flavor
    const hype = [
        "Stay sharp and keep’em honest.",
        "Eyes up; space is busy today.",
        "Steady as she goes.",
        "We’ve got this—tight formation.",
    ];
    return hype[iran(hype.length)];
}
