// src/bots/general.ts
// Command-line bot: composes player commands and queues them via the dispatcher.

import { Player } from "../player.js";
import { NullSocket } from "../util/nullsocket.js";
import { GRID_HEIGHT, GRID_WIDTH, MAX_SHIELD_ENERGY } from "../settings.js";
import { players, bases } from "../game.js";
import { ran, iran } from "../util/random.js";
import { getAvailableShips } from "../pregame.js";
import { Planet } from "../planet.js";
import { chebyshev, findEmptyLocation } from "../coords.js";
import { queueCommands } from "../command.js"; // <- all actions go through here

// ===== Tuning ===============================================================
type Side = "FEDERATION" | "EMPIRE";

const KRANGE = 20;            // search/engage window (Chebyshev)
const CLOSE_RANGE = 6;        // inside this, start firing
const MOVE_MAX_STEP = 5;      // cap each MOVE to Chebyshev <= 5 (user asked: < 6)
const PHA_COOLDOWN_MS = 1200; // pacing so we don’t spam
const TORP_COOLDOWN_MS = 2000;
const FIRE_BIAS = 0.55;       // prefer phasers when both ready
// ===========================================================================

// Per-bot cooldowns
const phaUntil = new WeakMap<Player, number>();
const torpUntil = new WeakMap<Player, number>();
const nextChatterAt = new WeakMap<Player, number>(); // chatter rate-limiter

function tagAsBot(p: Player): void {
    (p as any).__cmdBot = true;
    if (p.ship) p.ship.romulanStatus = { isRomulan: false, isRevealed: true, cloaked: false };
    const now = Date.now();
    phaUntil.set(p, now + 500);
    torpUntil.set(p, now + 1000);
    nextChatterAt.set(p, now + 3000);
}

export function isBotPlayer(p: Player): boolean {
    if ((p as any).__cmdBot === true) return true;
    const n = p.settings.name ?? "";
    return /^BOT-/.test(n);
}

export function spawnSideBot(side: Side, name = `BOT-${side[0]}${iran(1000)}`): Player | null {
    // Abort early if no ship names are available for this side.
    const available = getAvailableShips(side);
    if (available.length === 0) return null;

    const pl = new Player(new NullSocket());
    pl.settings.name = name;
    (pl.settings as any).location = "virtual";
    (pl.settings as any).ip = "virtual";
    (pl.settings as any).userAgent = "virtual-bot";
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

    players.push(pl);
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
        if (fed < emp) {
            targetSide = "FEDERATION";
        } else if (emp < fed) {
            targetSide = "EMPIRE";
        } else {
            targetSide = ran() < 0.5 ? "FEDERATION" : "EMPIRE";
        }

        // Try target side first, then the other if target fails.
        const order: Side[] = [targetSide, targetSide === "FEDERATION" ? "EMPIRE" : "FEDERATION"];
        let spawned = false;

        for (const side of order) {
            // Skip if no ships left for this side.
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

        // If we couldn't spawn on either side (no ships left), abort.
        if (!spawned) break;
    }
}

// Drive every bot each sweep
export function updateSideBots(): void {
    for (const bot of players) {
        if (!bot.ship) continue;
        if (!isBotPlayer(bot)) continue;
        driveBot(bot);
    }
}

// ===== Core AI ==============================================================
type Target =
    | { kind: "ship"; player: Player; distance: number }
    | { kind: "base"; planet: Planet; distance: number };

function driveBot(bot: Player): void {
    if (!bot.ship) return;

    // light captain chatter at roughly the same cadence as Romulan speech
    maybeChatter(bot);

    const target = findClosestTarget(bot);
    if (!target) {
        randomWander(bot);
        return;
    }

    const tpos = target.kind === "ship" ? target.player.ship!.position : target.planet.position;
    const dist = chebyshev(bot.ship.position, tpos);

    if (dist > CLOSE_RANGE) {
        moveToward(bot, tpos);
        return;
    }

    // Cooldown gating
    const now = Date.now();
    const phaReady = now >= (phaUntil.get(bot) ?? 0);
    const torpReady = now >= (torpUntil.get(bot) ?? 0);

    if (!phaReady && !torpReady) return;

    // Choose weapon (both paths emit real commands)
    if (phaReady && torpReady) {
        if (ran() < FIRE_BIAS) firePhasers(bot, target);
        else fireTorpedo(bot, target);
    } else if (phaReady) {
        firePhasers(bot, target);
    } else {
        fireTorpedo(bot, target);
    }
}

function findClosestTarget(bot: Player): Target | null {
    if (!bot.ship) return null;
    const pos = bot.ship.position;
    const enemySide: Side = bot.ship.side === "FEDERATION" ? "EMPIRE" : "FEDERATION";

    let best: Target | null = null;

    // Prefer enemy ships
    for (const p of players) {
        if (!p.ship || p === bot) continue;
        if (p.ship.side !== enemySide) continue;
        const d = chebyshev(p.ship.position, pos);
        if (d > KRANGE) continue;
        if (!best || d < best.distance) best = { kind: "ship", player: p, distance: d };
    }

    // Then enemy bases
    const list = enemySide === "FEDERATION" ? bases.federation : bases.empire;
    for (const base of list) {
        const d = chebyshev(base.position, pos);
        if (d > KRANGE) continue;
        if (!best || d < best.distance) best = { kind: "base", planet: base, distance: d };
    }

    return best;
}

// ===== Chatter ==============================================================
function maybeChatter(bot: Player): void {
    if (!bot.ship) return;
    const now = Date.now();
    const notBefore = nextChatterAt.get(bot) ?? 0;
    // ~10% chance when allowed, then cooldown 8–15s
    if (now < notBefore || ran() > 0.10) return;

    // pick audience: 60% SIDE, 30% ALL, 10% single friendly ship
    const roll = ran();
    let audience = "ALL";
    if (roll < 0.60) {
        audience = bot.ship.side; // tell your own side
    } else if (roll < 0.90) {
        audience = "ALL";
    } else {
        const friend = players.find(p => p !== bot && p.ship && p.ship.side === bot.ship!.side);
        audience = friend?.ship?.name ?? bot.ship.side;
    }

    const line = generateCaptainLine(bot);
    // TELL <audience>; message
    queueCommands(bot, `TELL ${audience}; ${line}`);
    // set next window
    nextChatterAt.set(bot, now + (8000 + iran(7000)));
}

function generateCaptainLine(bot: Player): string {
    if (!bot.ship) return "Standing by.";
    const { position, shieldEnergy, name } = bot.ship;
    const shieldPct = Math.max(0, Math.min(100, Math.round((shieldEnergy / Math.max(1, MAX_SHIELD_ENERGY)) * 100)));
    const here = `${position.v}-${position.h}`;

    const setA = [
        `Eyes up—contact near ${here}.`,
        `Moving to intercept at ${here}.`,
        `Phasers hot, targeting now.`,
        `Tube one ready—launching soon.`,
        `Shields holding at ${shieldPct}%.`,
        `Requesting cover at ${here}.`,
        `Plotting a short hop toward target.`,
        `We have them on scopes, closing.`,
        `All hands, stand by for maneuvers.`,
        `${name} on station at ${here}.`,
    ];
    return setA[iran(setA.length)];
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
function moveToward(bot: Player, targetPos: { v: number; h: number }): void {
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

    // Queue: MOVE R <rv> <rh>
    queueCommands(bot, `MOVE R ${rvBound} ${rhBound}`);
}

function firePhasers(bot: Player, target: Target): void {
    if (!bot.ship) return;
    const from = bot.ship.position;
    const tpos = target.kind === "ship" ? target.player.ship!.position : target.planet.position;

    // RELATIVE offsets, clamped to phaser max range in the command layer (we still clamp to 10)
    const rv = Math.max(-10, Math.min(10, tpos.v - from.v));
    const rh = Math.max(-10, Math.min(10, tpos.h - from.h));

    // Default energy (200) chosen by the command itself.
    // Command: PH R <rv> <rh>
    queueCommands(bot, `PH R ${rv} ${rh}`);

    phaUntil.set(bot, Date.now() + PHA_COOLDOWN_MS);
}

function fireTorpedo(bot: Player, target: Target): void {
    if (!bot.ship) return;
    const from = bot.ship.position;
    const tpos = target.kind === "ship" ? target.player.ship!.position : target.planet.position;

    // RELATIVE offsets for torpedo; one tube
    const rv = tpos.v - from.v;
    const rh = tpos.h - from.h;

    // Command: TO R 1 <rv> <rh>
    queueCommands(bot, `TO R 1 ${rv} ${rh}`);

    torpUntil.set(bot, Date.now() + TORP_COOLDOWN_MS);
}

// ===== Fallback if no targets: small MOVE R jitter ==========================
function randomWander(bot: Player): void {
    if (!bot.ship) return;

    // pick a random Chebyshev step size 1..MOVE_MAX_STEP and move in that square
    const step = 1 + iran(MOVE_MAX_STEP); // 1..5

    // random offsets in [-step, step], with a non-zero displacement
    let dv = iran(2 * step + 1) - step;
    let dh = iran(2 * step + 1) - step;
    if (dv === 0 && dh === 0) dv = 1; // ensure some movement

    // clamp to board and re-derive the actually valid offsets
    const from = bot.ship.position;
    const toV = Math.max(1, Math.min(GRID_HEIGHT, from.v + dv));
    const toH = Math.max(1, Math.min(GRID_WIDTH, from.h + dh));
    const rv = toV - from.v;
    const rh = toH - from.h;

    if (rv !== 0 || rh !== 0) {
        // Single MOVE command with Chebyshev distance ≤ step (≤ MOVE_MAX_STEP)
        queueCommands(bot, `MOVE R ${rv} ${rh}`);
    }
}
