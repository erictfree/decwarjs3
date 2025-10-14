import { Player } from './player.js';
import { Command } from './command.js';
import {
    addPendingMessage,
    putClientOnHold,
    releaseClient,
    sendMessageToClient,
    sendMessageToOthers
} from './communication.js';
import {
    MAX_SHIELD_ENERGY,
    MAX_TORPEDO_RANGE,
    GRID_HEIGHT,
    GRID_WIDTH,
    CoordMode,
    OutputSetting
} from './settings.js';
import { Planet } from './planet.js';
import { isInBounds, bresenhamLine, chebyshev, ocdefCoords } from './coords.js';
import { players, bases, planets, stars, blackholes, pointsManager, removePlayerFromGame, checkEndGame } from './game.js';
import { handleUndockForAllShipsAfterPortDestruction } from './ship.js';
import { triggerNovaAt } from './nova.js';
import { Star } from './star.js';
import { Blackhole } from './blackhole.js';
import { maybeApplyShipCriticalParity } from './phaser.js';
import { Side } from './settings.js';
import { gameEvents, planetRef } from './api/events.js';
import { emitShipDestroyed, attackerRef, emitPlanetHit, emitShipHullChanged, emitShieldsChanged } from './api/events.js';

type ScoringAPI = {
    addDamageToBases?(amount: number, source: Player, side: Side): void;
    addEnemiesDestroyed?(count: number, source: Player, side: Side): void;
    addDamageToEnemies?(amount: number, source: Player, side: Side): void;
};

import { SHIP_FATAL_DAMAGE } from './game.js';

type TorpedoCollision =
    | { type: "ship"; player: Player }
    | { type: "planet"; planet: Planet }
    | { type: "star"; star: Star }
    | { type: "blackhole"; blackhole: Blackhole }
    | { type: "target"; point: Point } // reached target with no collision
    | { type: "boundary"; point: Point } // reached grid boundary
    | null;

type Point = { v: number; h: number };

// Single source of truth for torpedo hull scaling (DECWAR vibe ≈ ×0.1)
const TORP_HULL_SCALE = 0.1;

function formatTorpedoShipHit(opts: {
    attackerInitial: string;
    targetInitial: string;
    atkPos: { v: number; h: number };
    offset: string;                     // e.g. "+5,+1"
    beforePct: number;                  // one decimal (e.g. 81.2)
    damageUnits: number;                // one decimal
    deflected?: boolean;
    deflectTo?: { v: number; h: number } | null;
    deltaPct: number;                   // one decimal, often negative
    critDeviceName?: string;
    output: OutputSetting;
}): string {
    const {
        attackerInitial, targetInitial, atkPos, offset, beforePct,
        damageUnits, deflected, deflectTo, deltaPct, critDeviceName, output
    } = opts;

    const sign = deltaPct >= 0 ? "+" : "";
    const arrow = deflected && deflectTo ? ` -->${deflectTo.v}-${deflectTo.h},` : "";
    const critTextLong = critDeviceName ? `; ${critDeviceName} dam ${Math.round(damageUnits)}` : "";
    const critTextMed = critDeviceName ? `; ${critDeviceName} ${Math.round(damageUnits)}` : "";
    const critTextShort = critDeviceName ? `; ${critDeviceName[0]} ${Math.round(damageUnits)}` : "";

    switch (output) {
        case "LONG":
            // Full DECWAR-style with before% and arrow if deflected
            return `${attackerInitial}> ${targetInitial} @${atkPos.v}-${atkPos.h} ${offset}, +${beforePct}% ${damageUnits.toFixed(1)} unit T ${targetInitial} ${arrow} ${sign}${deltaPct}%${critDeviceName ? `; ${critDeviceName} dam ${Math.round(damageUnits)}` : ""}`;
        case "MEDIUM":
            // Keep coords and core numbers, drop some words
            return `${attackerInitial}> ${targetInitial} @${atkPos.v}-${atkPos.h} ${damageUnits.toFixed(1)}T ${sign}${deltaPct}%${critTextMed}`;
        case "SHORT":
        default:
            // Compact: initials, damage, and shield delta
            return `${attackerInitial}> ${targetInitial} ${Math.round(damageUnits)}T ${sign}${deltaPct}%${critTextShort}`;
    }
}

function getPointTenStepsAway(start: Point, end: Point): Point {
    // Direction vector from start to end
    const dh = end.h - start.h; // Δh
    const dv = end.v - start.v; // Δv

    // Euclidean distance (magnitude of direction vector)
    const magnitude = Math.sqrt(dh * dh + dv * dv);

    if (magnitude === 0) {
        // If start and end are the same, return start
        return { v: start.v, h: start.h };
    }

    // Normalize direction vector
    const unitH = dh / magnitude;
    const unitV = dv / magnitude;

    // Move 10 steps along the direction
    const steps = 10;
    let newH = start.h + unitH * steps;
    let newV = start.v + unitV * steps;

    // Round to nearest grid point (integer coordinates)
    newH = Math.round(newH);
    newV = Math.round(newV);

    // Clamp to grid boundaries
    newH = Math.max(1, Math.min(GRID_WIDTH, newH));
    newV = Math.max(1, Math.min(GRID_HEIGHT, newV));

    return { v: newV, h: newH };
}

function traceTorpedoPath(player: Player, start: Point, target: Point): TorpedoCollision {

    if (!isInBounds(start.v, start.h) || !isInBounds(target.v, target.h)) {
        sendMessageToClient(player, `Start ${JSON.stringify(start)} or target ${JSON.stringify(target)} is outside grid boundaries`);
        return null;
    }

    const { v: endV, h: endH } = getPointTenStepsAway(start, target);
    const points = bresenhamLine(start.v, start.h, endV, endH);
    let skipFirst = true;

    for (const { v, h } of points) {
        if (skipFirst) {
            skipFirst = false;
            continue; // Skip the attacker's own position
        }

        // Verify point is within grid (defensive check)
        if (!isInBounds(v, h)) {
            sendMessageToClient(player, `Bresenham point (${v}, ${h}) is outside grid boundaries`);
            return null;
        }

        // Check for ship
        const ship = players.find(p => p.ship && p.ship.position.v === v && p.ship.position.h === h);
        if (ship) return { type: "ship", player: ship };

        // Check for planet
        const planet = planets.find(p => p.position.h === h && p.position.v === v);
        if (planet) return { type: "planet", planet: planet };

        // Check for star
        const star = stars.find(star => star.position.v === v && star.position.h === h);
        if (star) {
            return { type: "star", star: star };
        }

        // Check for black hole
        const blackhole = blackholes.find(bh => bh.position.v === v && bh.position.h === h);
        if (blackhole) {
            return { type: "blackhole", blackhole: blackhole };
        }
    }

    // No collision, reached the grid boundary
    const boundaryPoint = { v: endV, h: endH };
    // if (!isInBounds(boundaryPoint.v, boundaryPoint.h)) {
    //     throw new Error(`Boundary point ${JSON.stringify(boundaryPoint)} is outside grid boundaries`);
    // }
    return { type: "boundary", point: boundaryPoint };
}


function getTargetsFromCommand(player: Player, args: string[], mode: "ABSOLUTE" | "RELATIVE" | "COMPUTED", cursor: number, n: number): { v: number; h: number }[] | null {
    const targets: { v: number; h: number }[] = [];
    if (!player.ship) {
        sendMessageToClient(player, "You must be in a ship to fire torpedoes.");
        return null;
    }

    if (mode === "COMPUTED") {
        const matchedShips: { v: number; h: number }[] = [];
        while (cursor < args.length) {
            const partialName = args[cursor++].toUpperCase();
            const match = players.find(p => p.ship && p.ship.name && p.ship.name.toUpperCase().startsWith(partialName));
            if (!match) {
                sendMessageToClient(player, `No ship found matching '${partialName}'.`);
                return null;
            }
            if (match.ship) {
                matchedShips.push({ v: match.ship.position.v, h: match.ship.position.h });
            }
        }
        if (matchedShips.length === 0) {
            sendMessageToClient(player, "At least one valid ship name must be provided.");
            return null;
        }
        targets.push(...repeatOrTrim(matchedShips, n));
    } else {
        const coordPairs: { v: number, h: number; }[] = [];
        if (mode === "RELATIVE") {
            while (cursor + 1 < args.length) {
                const dv = parseInt(args[cursor++]);
                const dh = parseInt(args[cursor++]);
                if (isNaN(dv) || isNaN(dh)) {
                    sendMessageToClient(player, "Invalid RELATIVE coordinate offset.");
                    return null;
                }
                coordPairs.push({
                    v: player.ship.position.v + dv,
                    h: player.ship.position.h + dh
                });
            }
        } else {
            while (cursor + 1 < args.length) {
                const v = parseInt(args[cursor++]);
                const h = parseInt(args[cursor++]);
                if (isNaN(v) || isNaN(h)) {
                    sendMessageToClient(player, "Invalid coordinate pair.");
                    return null;
                }
                coordPairs.push({ v, h });
            }
        }
        if (coordPairs.length === 0) {
            sendMessageToClient(player, "At least one coordinate pair is required.");
            return null;
        }
        targets.push(...repeatOrTrim(coordPairs, n));
    }

    return targets;
}
function emitTorpedoEvent(attacker: Player, from: Point, aim: Point, coll: TorpedoCollision) {
    if (!attacker.ship || !coll) return;

    const by = { shipName: attacker.ship.name, side: attacker.ship.side };

    const collision =
        coll.type === "ship" ? { kind: "ship", name: coll.player.ship!.name, side: coll.player.ship!.side, position: { ...coll.player.ship!.position } } :
            coll.type === "planet" ? (coll.planet.isBase
                ? { kind: "base", name: coll.planet.name, side: coll.planet.side, position: { ...coll.planet.position } }
                : { kind: "planet", name: coll.planet.name, side: coll.planet.side, position: { ...coll.planet.position } }) :
                coll.type === "star" ? { kind: "star", position: { ...coll.star.position } } :
                    coll.type === "blackhole" ? { kind: "blackhole", position: { ...coll.blackhole.position } } :
                        coll.type === "boundary" ? { kind: "boundary", position: { ...coll.point } } :
                            { kind: "none" };

    gameEvents.emit({
        type: "torpedo",
        payload: {
            by,
            from: { v: from.v, h: from.h },
            aim: { v: aim.v, h: aim.h },
            collision
            // (optional) result/damage/crit/killed/novaTriggered can be added later
        },
    });
}


export function torpedoCommand(player: Player, command: Command, done?: () => void): void {
    const args = command.args;
    if (!player.ship) {
        sendMessageToClient(player, "You must be in a ship to fire torpedoes.");
        done?.();
        return;
    }

    if (!player.ship.isDeviceOperational("torpedo")) {
        done?.();
        return;
    }
    // if (Date.now() < player.ship.cooldowns.torpedoesReadyAt) {
    //     sendMessageToClient(player, "Torpedo tubes not yet reloaded.");
    //     done?.();
    //     return;
    // }

    if (args.length < 2) {
        sendMessageToClient(player, "Usage: TORPEDO [A|R|C] <1–3> <targets...>");
        done?.();
        return;
    }

    // Determine mode
    let mode: CoordMode;
    let cursor = 0;
    const modeArg = args[0].toUpperCase();

    if (["A", "ABSOLUTE"].includes(modeArg)) { mode = "ABSOLUTE"; cursor++; }
    else if (["R", "RELATIVE"].includes(modeArg)) { mode = "RELATIVE"; cursor++; }
    else if (["C", "COMPUTED"].includes(modeArg)) { mode = "COMPUTED"; cursor++; }
    else { mode = player.settings.icdef; }

    const n = parseInt(args[cursor++]);
    if (isNaN(n) || n < 1 || n > 3) {
        sendMessageToClient(player, "You must fire between 1 and 3 torpedoes.");
        done?.();
        return;
    }

    if (player.ship.torpedoes < n) {
        sendMessageToClient(player, "Not enough torpedoes.");
        done?.();
        return;
    }

    if (mode === "COMPUTED" && !player.ship.isDeviceOperational("computer")) {
        done?.();
        return;
    }

    const targets = getTargetsFromCommand(player, args, mode, cursor, n);
    if (!targets) {
        done?.();
        return;
    }

    for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        if (target.v === player.ship.position.v && target.h === player.ship.position.h) {
            sendMessageToClient(player, "Cannot target your own position.");
            continue;
        }
        const range = chebyshev(player.ship.position, target);
        if (range > MAX_TORPEDO_RANGE) {
            sendMessageToClient(player, formatTorpedoOutOfRange(player, target.v, target.h));
            continue;
        }

        const collision = traceTorpedoPath(player, player.ship.position, target);
        if (!collision) {
            continue;
        }

        // single authoritative telemetry event
        emitTorpedoEvent(player, player.ship.position, target, collision);

        let fired = false;
        switch (collision?.type) {
            case "ship": {
                const victim = collision.player;

                const energyBefore = victim.ship!.energy;
                const damageBefore = victim.ship!.damage;
                const shieldsBefore = victim.ship!.shieldEnergy;
                const atk = player.ship!;
                const vic = victim.ship!;
                const attackerInitial = atk.name?.[0] ?? '?';
                const targetInitial = vic.name?.[0] ?? '?';
                const beforePct = Math.round((Math.max(0, shieldsBefore) / Math.max(1, MAX_SHIELD_ENERGY)) * 1000) / 10; // one decimal
                const dv = vic.position.v - atk.position.v;
                const dh = vic.position.h - atk.position.h;
                const off = `${dh >= 0 ? "+" : ""}${dh},${dv >= 0 ? "+" : ""}${dv}`;


                const res = torpedoDamage(player, victim);
                fired = true;

                // hull/energy aggregate
                emitShipHullChanged(
                    victim,
                    energyBefore,
                    victim.ship!.energy,
                    damageBefore,
                    victim.ship!.damage,
                    "torpedo",
                    player
                );

                // shields delta (only if changed)
                if (victim.ship && shieldsBefore !== victim.ship.shieldEnergy) {
                    emitShieldsChanged(victim, shieldsBefore, victim.ship.shieldEnergy);
                }

                const afterPct = Math.round((Math.max(0, vic.shieldEnergy) / Math.max(1, MAX_SHIELD_ENERGY)) * 1000) / 10;
                const deltaPct = Math.round((afterPct - beforePct) * 10) / 10; // likely negative
                const dmg = Math.round((res.hita + Number.EPSILON) * 10) / 10; // one decimal
                const atCoords = `${atk.position.v}-${atk.position.h}`;
                const arrow = res.deflected && res.deflectTo ? ` -->${res.deflectTo.v}-${res.deflectTo.h},` : "";
                const critText = res.critdm
                    ? `; ${res.critDeviceName ?? "Device"} dam ${res.critdm}`
                    : "";

                // DECWAR-style line
                const line = `${attackerInitial}> ${targetInitial} @${atCoords} ${off}, +${beforePct}% ${dmg} unit T ${targetInitial} ${arrow} ${deltaPct >= 0 ? "+" : ""}${deltaPct}%${critText}`;
                sendMessageToClient(player, line);

                // victim gets a shorter "you were hit" note (your choice)
                addPendingMessage(victim, `${atk.name} torpedo ${dmg} on you${res.critdm ? " (CRIT)" : ""}.`);

                if (res.isDestroyed) checkEndGame();
                break;
            }



            case "planet": {
                const p = collision.planet;

                // (optional) capture before if you want it; event only needs after/damage
                // const energyBefore = p.energy;

                const res = torpedoDamage(player, p); // will no-op on non-base planets by validation
                fired = true;

                // emit per-impact planet/base damage event
                emitPlanetHit(p, "torpedo", res.hita, res.isDestroyed, player);

                const coords = ocdefCoords(player.settings.ocdef, player.ship.position, p.position);
                if (p.isBase) {
                    sendMessageToClient(player, `Torpedo ${res.hita > 0 ? `hit base @${coords} for ${Math.round(res.hita)} damage` : `was deflected @${coords}`}${res.critdm ? " (CRIT)" : ""}.`);
                    if (res.isDestroyed) checkEndGame();
                } else {
                    // Non-base planets are inert to torpedoes per your validation
                    sendMessageToClient(player, `Torpedo impact on planet @${coords} had no significant effect.`);
                }
                break;
            }

            case "star":
                sendMessageToClient(player, formatTorpedoExplosion(player, collision.star.position.v, collision.star.position.h));
                if (Math.random() < 0.8) {
                    triggerNovaAt(player, collision.star.position.v, collision.star.position.h);
                }
                fired = true;
                break;

            case "blackhole":
                sendMessageToClient(player, formatTorpedoLostInVoid(player, collision.blackhole.position.v, collision.blackhole.position.h));
                fired = true;
                break;

            case "boundary": {
                const { v, h } = collision.point;
                sendMessageToClient(player, `Torpedo flew off to ${ocdefCoords(player.settings.ocdef, player.ship.position, { v, h })} and detonated harmlessly.`);
                fired = true;
                break;
            }

            default:
                sendMessageToClient(player, `Torpedo failed to reach target.`);
                fired = true;
                break;
        }


        if (i !== targets.length - 1) { // not last target
            if (fired) {
                player.ship.torpedoes--;
                sendMessageToOthers(player, formatTorpedoBroadcast(player, target.v, target.h));

                if (player.ship.romulanStatus.isRomulan) {
                    player.ship.romulanStatus.isRevealed = true;
                    setTimeout(() => {
                        if (player.ship)
                            player.ship.romulanStatus.isRevealed = false;
                    }, 5000);   // TODO is this right?
                }
            }
        } else { // last target
            const captureDelayMs = 2000 + Math.random() * 2000 + player.ship.devices.torpedo / 100;
            if (fired) {
                putClientOnHold(player, "");
                const timer = setTimeout(() => {
                    releaseClient(player);
                    if (player.ship) {
                        player.ship.torpedoes--;
                    }
                    sendMessageToOthers(player, formatTorpedoBroadcast(player, target.v, target.h));

                    if (player.ship && player.ship.romulanStatus.isRomulan) {
                        player.ship.romulanStatus.isRevealed = true;
                        setTimeout(() => {
                            if (player.ship) {
                                player.ship.romulanStatus.isRevealed = false;
                            }
                        }, 5000);   // TODO is this right?
                    }
                    done?.();
                }, captureDelayMs);
                player.currentCommandTimer = timer;
            } else {
                done?.();
                return;
            }
        }
    }
    done?.();
}



function repeatOrTrim<T>(items: T[], n: number): T[] {
    const result: T[] = [];
    for (let i = 0; i < n; i++) {
        result.push(i < items.length ? items[i] : items[items.length - 1]);
    }
    return result;
}

function formatTorpedoOutOfRange(player: Player, v: number, h: number): string {
    const coords = ocdefCoords(player.settings.ocdef, player.ship?.position ?? { v: 0, h: 0 }, { v, h });

    switch (player.settings.output) {
        case "SHORT":
            return `F > ${coords} No impact`;
        case "MEDIUM":
            return `Torpedo did not reach ${coords} `;
        case "LONG":
        default:
            return `Torpedo launch aborted.Target at ${coords} is beyond maximum range.`;
    }
}
function formatTorpedoLostInVoid(player: Player, v: number, h: number): string {
    const coords = ocdefCoords(player.settings.ocdef, player.ship?.position ?? { v: 0, h: 0 }, { v, h });

    switch (player.settings.output) {
        case "SHORT":
            return `F > ${coords} Vanished`;
        case "MEDIUM":
            return `Torpedo swallowed by black hole`;
        case "LONG":
        default:
            return `Torpedo lost at ${coords}. Possible gravitational anomaly encountered.`;
    }
}

function formatTorpedoExplosion(player: Player, v: number, h: number): string {
    const coords = ocdefCoords(player.settings.ocdef, player.ship?.position ?? { v: 0, h: 0 }, { v, h });

    switch (player.settings.output) {
        case "SHORT":
            return `F > ${coords} BOOM`;
        case "MEDIUM":
            return `Explosion at ${coords}!`;
        case "LONG":
        default:
            return `Torpedo triggered explosion at ${coords}. Unstable celestial mass may have ignited.`;
    }
}


function formatTorpedoBroadcast(player: Player, v: number, h: number): string {
    const coords = ocdefCoords(player.settings.ocdef, player.ship?.position ?? { v: 0, h: 0 }, { v, h });
    switch (player.settings.output) {
        case "SHORT":
            return `F > ${coords} `;
        case "MEDIUM":
            return `Torpedo launched toward ${coords} `;
        case "LONG":
        default:
            return `${player.ship?.name ?? "Unknown"} has launched a torpedo toward ${coords}.`;
    }
}

// (no flat crit chance; we use thresholded crits in maybeApplyShipCriticalParity)
// Torpedo damage (TORDAM entry point) — parity-focused
// Torpedo damage (TORDAM entry point) — parity-focused
// --- Torpedo damage (TORDAM parity) ---------------------------------------
export function torpedoDamage(
    source: Player | Planet,
    target: Player | Planet
): {
    hita: number;
    isDestroyed: boolean;
    shieldStrength: number;
    shieldsUp: boolean;
    critdm: number;
    deflected?: boolean;
    deflectTo?: { v: number; h: number };
    critDeviceName?: string;
} {
    // Validate target state
    if (target instanceof Player) {
        const ship = target.ship;
        if (!ship || ship.energy <= 0 || ship.damage >= SHIP_FATAL_DAMAGE) {
            return { hita: 0, isDestroyed: false, shieldStrength: 0, shieldsUp: false, critdm: 0 };
        }
    } else if (target instanceof Planet) {
        // Only bases take torpedo damage
        if (!target.isBase || target.energy <= 0) {
            return { hita: 0, isDestroyed: false, shieldStrength: 0, shieldsUp: false, critdm: 0 };
        }
    } else {
        return { hita: 0, isDestroyed: false, shieldStrength: 0, shieldsUp: false, critdm: 0 };
    }

    const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
    const toPct = (energy: number, max: number) => (max > 0 ? clamp((energy / max) * 1000, 0, 1000) : 0);
    const fromPct = (pct: number, max: number) => clamp((pct / 1000) * max, 0, max);

    const isPlayer = target instanceof Player && !!target.ship;
    const isBase = target instanceof Planet && target.isBase;

    let rawShieldEnergy = isPlayer ? target.ship!.shieldEnergy : (target as Planet).energy; // bases store 0..1000
    const rawShieldMax = isPlayer ? MAX_SHIELD_ENERGY : 1000;
    const shieldsUp = isPlayer ? !!target.ship!.shieldsUp : true; // bases always treated as shielded

    let shieldPct = toPct(rawShieldEnergy, rawShieldMax);

    // Base torpedo hit (Fortran TORDAM): 4000..8000
    const hit = 4000.0 + 4000.0 * Math.random();
    const rana = Math.random();

    // Deflection test (ONLY when shields are actually up)
    if (shieldsUp && shieldPct > 0) {
        const rand = Math.random();
        const rand2 = rana - (shieldPct * 0.001 * rand) + 0.1;

        if (rand2 <= 0.0) {
            // Deflected: drain some shields (50 * rana on 0..1000 scale)
            const drain = 50.0 * rana;
            shieldPct = clamp(shieldPct - drain, 0, 1000);
            rawShieldEnergy = fromPct(shieldPct, rawShieldMax);

            if (isPlayer) {
                target.ship!.shieldEnergy = rawShieldEnergy;
                addPendingMessage(target, `Your ship's shields deflected a torpedo, losing ${Math.round(drain)} shield units!`);
            } else {
                (target as Planet).energy = rawShieldEnergy;
            }

            return {
                hita: 0,
                isDestroyed: false,
                shieldStrength: rawShieldEnergy,
                shieldsUp,
                critdm: 0,
                deflected: true,
                deflectTo: isPlayer
                    ? { v: target.ship!.position.v, h: target.ship!.position.h } // DECWAR shows the *cell the torp hops to*; we don't move it, so show victim cell
                    : { v: (target as Planet).position.v, h: (target as Planet).position.h }
            };
        }
    }

    // Damage through shields + drain
    let hita = hit;
    const prevShieldPct = shieldPct;

    // Absorption/drain ONLY when shields are up
    if (shieldsUp && shieldPct > 0) {
        // Portion that penetrates
        hita = hit * (1000.0 - shieldPct) * 0.001;

        // Drain shields
        const absorptionFactor = Math.max(shieldPct * 0.001, 0.1);
        shieldPct = shieldPct - (hit * absorptionFactor + 10.0) * 0.03;
        if (shieldPct < 0) shieldPct = 0;

        // Write back
        rawShieldEnergy = fromPct(shieldPct, rawShieldMax);
        if (isPlayer) {
            target.ship!.shieldEnergy = rawShieldEnergy;
        } else {
            (target as Planet).energy = rawShieldEnergy;
        }
    }

    // Base collapse crit/kill BEFORE hull
    let critdm = 0;
    let critDeviceName: string | undefined;
    if (isBase && shieldsUp && prevShieldPct > 0 && shieldPct === 0) {
        const rana2 = Math.random();
        const extra = 50 + Math.floor(100 * rana2); // 50..149
        (target as Planet).energy = Math.max(0, (target as Planet).energy - extra);
        critdm = 1;

        if (Math.random() < 0.10 || (target as Planet).energy <= 0) {
            // Base killed via collapse: award and remove
            // (ensure you have this import somewhere near the top of the file)
            // import { gameEvents } from "./api/events.js";

            if (source instanceof Player && source.ship) {
                const atkSide = source.ship.side;
                const tgtSide = (target as Planet).side;
                const sign = atkSide !== tgtSide ? 1 : -1;

                (pointsManager as unknown as ScoringAPI).addDamageToBases?.(10000 * sign, source, atkSide);
                (pointsManager as unknown as ScoringAPI).addEnemiesDestroyed?.(1, source, atkSide);
            }

            // --- base removal / collapse ---
            {
                const base = target as Planet;
                const prevSide = base.side; // capture before mutation

                // mutate base (isBase=false, energy=0, builds=0, undock, etc.)
                gameEvents.emit({
                    type: "planet_base_removed",
                    payload: {
                        planet: planetRef(base),
                        by: attackerRef(source instanceof Player ? source : undefined),
                        reason: "collapse_torpedo",
                        previousSide: prevSide,
                    },
                });

                // remove from the correct team list using the captured side
                const arr = prevSide === "FEDERATION" ? bases.federation : bases.empire;
                const idx = arr.indexOf(base);
                if (idx !== -1) arr.splice(idx, 1);

                // mutate planet state
                base.isBase = false;
                base.builds = 0;
                base.energy = 0;
                // Fortran semantics typically keep the planet's side after base destruction.
                // If you intend to neutralize immediately, do it explicitly:
                // base.side = "NEUTRAL";

                handleUndockForAllShipsAfterPortDestruction(base);

                // emit event with correct previous side and current position
                gameEvents.emit({
                    type: "planet_base_removed",
                    payload: {
                        planet: {
                            name: base.name,
                            previousSide: prevSide,
                            position: { ...base.position },
                            energy: base.energy,
                            builds: base.builds,
                        },
                        by: (source instanceof Player && source.ship)
                            ? { shipName: source.ship.name, side: source.ship.side }
                            : undefined,
                        reason: "collapse_torpedo",
                    },
                });
            }



            return {
                hita, // pre-scale raw hit for telemetry, but base is gone
                isDestroyed: true,
                shieldStrength: 0,
                shieldsUp: false,
                critdm,
            };
        }
    }

    // Ship critical (device damage) BEFORE hull — thresholded, no flat chance
    if (isPlayer) {
        const victim = target as Player; // narrow once

        const crit = maybeApplyShipCriticalParity(victim, hita);

        if (crit.isCrit) {
            // On crit: halve + ±500 jitter already applied inside helper
            hita = crit.hita;
            const TORP_HULL_SCALE = 0.1;   // keep this single source of truth
            critdm = Math.max(critdm, Math.round(crit.critdm * TORP_HULL_SCALE));

            const deviceKeys = Object.keys(victim.ship!.devices);
            const deviceName = deviceKeys[crit.critdv]?.toUpperCase?.() ?? "DEVICE";

            addPendingMessage(
                victim,
                crit.critdm > 0
                    ? `CRITICAL HIT: ${deviceName} damaged by ${crit.critdm}!`
                    : `CRITICAL HIT: ${deviceName} struck!`
            );
        } else {
            // Non-crit: integer hull like the original (no global jitter)
            hita = Math.max(0, Math.round(hita));
        }
    }

    // Scale raw torp impact into hull units (~×0.1) before applying/scoring
    const TORP_HULL_SCALE = 0.1;
    const hull = Math.max(0, Math.round(hita * TORP_HULL_SCALE));

    // Apply to target
    const result = applyDamage(source, target, hull, rana) || {
        hita: hull,
        isDestroyed: false,
        shieldStrength: isPlayer ? target.ship!.shieldEnergy : (target as Planet).energy,
        shieldsUp,
        critdm: 0,
    };

    // Award DAMAGE POINTS on the actual applied hull damage
    if (source instanceof Player && source.ship && result.hita > 0) {
        const atkSide = source.ship.side;

        if (isBase) {
            const sign = atkSide !== (target as Planet).side ? 1 : -1;
            (pointsManager as unknown as ScoringAPI).addDamageToBases?.(result.hita * sign, source, atkSide);
        } else if (isPlayer) {
            const sign = atkSide !== target.ship!.side ? 1 : -1;
            (pointsManager as unknown as ScoringAPI).addDamageToEnemies?.(result.hita * sign, source, atkSide);
        }
    }

    // Kill bonuses (post-state)
    if (source instanceof Player && source.ship && result.isDestroyed) {
        const atkSide = source.ship.side;

        if (isPlayer) {
            const sign = atkSide !== target.ship!.side ? 1 : -1;
            (pointsManager as unknown as ScoringAPI).addDamageToEnemies?.(5000 * sign, source, atkSide);
            // ship kill count already handled in applyDamage
        } else if (isBase) {
            const sign = atkSide !== (target as Planet).side ? 1 : -1;
            (pointsManager as unknown as ScoringAPI).addDamageToBases?.(10000 * sign, source, atkSide);
            (pointsManager as unknown as ScoringAPI).addEnemiesDestroyed?.(1, source, atkSide);
        }
    }

    // Surface crit flag and shield fields
    result.critdm = Math.max(result.critdm || 0, critdm);
    result.shieldsUp = isPlayer ? !!target.ship!.shieldsUp : true;
    result.shieldStrength = isPlayer ? target.ship!.shieldEnergy : (target as Planet).energy;

    return result;
}




// /**
//  * TORDAM-parity core for torpedo impact against shields/hull.
//  * Internally uses 0..1000 shield scale and converts back to your storage.
//  */
// function tordamCore(params: {
//     rawShieldEnergy: number; // current stored shield/energy
//     rawShieldMax: number;    // players: MAX_SHIELD_ENERGY; bases: 1000
// }): { hita: number; newShieldEnergy: number } {
//     const { rawShieldEnergy, rawShieldMax } = params;

//     const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
//     const toPct = (energy: number, max: number) =>
//         max > 0 ? clamp((energy / max) * 1000, 0, 1000) : 0;
//     const fromPct = (pct: number, max: number) => clamp((pct / 1000) * max, 0, max);

//     // Torpedo base impact (Fortran: 4000..8000 range)
//     let hit = 4000 + 4000 * Math.random();

//     // Shields in 0..1000 scale
//     let shieldPct = toPct(rawShieldEnergy, rawShieldMax);

//     // If shields are up, absorb part of the hit and drain shields
//     // Absorb: hit = (1000 - shield%) * hit * 0.001
//     // Drain:  shield% -= (hit * amax1(shield%*0.001, 0.1) + 10) * 0.03
//     if (shieldPct > 0) {
//         hit = (1000 - shieldPct) * hit * 0.001;

//         const absorptionFactor = Math.max(shieldPct * 0.001, 0.1);
//         shieldPct = shieldPct - (hit * absorptionFactor + 10) * 0.03;
//         if (shieldPct < 0) shieldPct = 0;
//     }

//     const hita = hit; // final torpedo damage post-absorption
//     return { hita, newShieldEnergy: fromPct(shieldPct, rawShieldMax) };
// }

// Shared damage resolver for phasers / torpedoes
// --- Shared damage resolver (phasers/torpedoes) ---------------------------
export function applyDamage(
    source: Player | Planet,
    target: Player | Planet,
    hita: number,
    rana: number
): { hita: number; isDestroyed: boolean; shieldStrength: number; shieldsUp: boolean; critdm: number } {
    void rana;
    const critdm = 0;
    let isDestroyed = false;

    // Ships
    if (target instanceof Player && target.ship) {
        target.ship.energy -= hita;
        target.ship.damage += hita / 2;

        // Clamp to avoid negative telemetry
        if (target.ship.energy < 0) target.ship.energy = 0;

        if (target.ship.energy <= 0 || target.ship.damage >= SHIP_FATAL_DAMAGE) {
            isDestroyed = true;
            emitShipDestroyed(
                target.ship.name,
                target.ship.side,
                { v: target.ship.position.v, h: target.ship.position.h },
                source instanceof Player ? attackerRef(source) : undefined,
                "combat"
            );
            removePlayerFromGame(target);
            if (source instanceof Player && source.ship) {
                pointsManager.addEnemiesDestroyed(1, source, source.ship.side);
            }
        }

        return {
            hita,
            isDestroyed,
            shieldStrength: target.ship.shieldEnergy,
            shieldsUp: !!target.ship.shieldsUp,
            critdm,
        };
    }

    // Bases
    if (target instanceof Planet && target.isBase) {
        target.energy -= hita;
        if (target.energy < 0) target.energy = 0;


        if (target.energy <= 0) {
            isDestroyed = true;

            // capture before mutation
            const prevSide = target.side;

            const arr = prevSide === "FEDERATION" ? bases.federation : bases.empire;
            const idx = arr.indexOf(target);
            if (idx !== -1) arr.splice(idx, 1);

            // mutate the planet
            target.isBase = false;
            target.energy = 0;
            target.builds = 0;
            // NOTE: Fortran semantics usually keep side until later recapture; 
            // if you demote to neutral immediately, do it explicitly here:
            // target.side = "NEUTRAL";

            handleUndockForAllShipsAfterPortDestruction(target);

            // emit with the captured previous side
            gameEvents.emit({
                type: "planet_base_removed",
                payload: {
                    planet: {
                        name: target.name,
                        previousSide: prevSide,               // <-- fix
                        position: { ...target.position }
                    },
                    reason: "collapse_torpedo"
                }
            });
        }


        return {
            hita,
            isDestroyed,
            shieldStrength: target.energy,
            shieldsUp: true,
            critdm,
        };
    }

    // Fallback (shouldn’t occur)
    return { hita, isDestroyed, shieldStrength: 0, shieldsUp: false, critdm };
}

