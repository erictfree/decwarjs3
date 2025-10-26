import { Player } from './player.js';
import { ran } from './util/random.js';
import { Command } from './command.js';
import { pointsManager, SHIP_FATAL_DAMAGE, players, bases, planets, stars, blackholes, removePlayerFromGame, checkEndGame } from './game.js';
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
import { handleUndockForAllShipsAfterPortDestruction } from './ship.js';
import { triggerNovaAt } from './nova.js';
import { Star } from './star.js';
import { Blackhole } from './blackhole.js';
import { maybeApplyShipCriticalParity } from './phaser.js';
import { Side } from './settings.js';
import { gameEvents } from './api/events.js';
import {
    emitShipDestroyed,
    attackerRef,
    emitPlanetHit,
    emitShipHullChanged,
    emitShieldsChanged,
    emitTorpedoEvent,
    emitRomulanDestroyed
} from './api/events.js';
import type { TorpedoEventPayload, GridCoord } from './api/events.js';
import { applyRomulanTorpedoHitFrom } from './romulan.js';

type ScoringAPI = {
    addDamageToBases?(amount: number, source: Player, side: Side): void;
    addEnemiesDestroyed?(count: number, source: Player, side: Side): void;
    addDamageToEnemies?(amount: number, source: Player, side: Side): void;
    addPlanetsDestroyed?(points: number, source: Player, side: Side): void;
};


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

// Default to LONG if not explicitly set
function getOutputSetting(p: Player): OutputSetting {
    return (p.settings.output ?? "LONG") as OutputSetting;
}

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
            return `${attackerInitial}> ${targetInitial} @${atkPos.v}-${atkPos.h} ${offset}, +${beforePct}% ${damageUnits.toFixed(1)} unit T ${targetInitial} ${arrow} ${sign}${deltaPct}%${critTextLong}`;
        case "MEDIUM":
            // Keep coords and core numbers, drop some words
            return `${attackerInitial}> ${targetInitial} @${atkPos.v}-${atkPos.h} ${damageUnits.toFixed(1)}T ${sign}${deltaPct}%${critTextMed}`;
        case "SHORT":
        default:
            // Compact: initials, damage, and shield delta
            return `${attackerInitial}> ${targetInitial} ${Math.round(damageUnits)}T ${sign}${deltaPct}%${critTextShort}`;
    }
}

function clampPointWithinRange(start: Point, end: Point, maxChebyshev: number): Point {
    // Limit travel to MAX_TORPEDO_RANGE steps in Chebyshev metric
    const dv = end.v - start.v;
    const dh = end.h - start.h;
    const dist = Math.max(Math.abs(dv), Math.abs(dh));
    if (dist <= maxChebyshev) return { v: end.v, h: end.h };
    const scale = maxChebyshev / dist;
    const v = Math.round(start.v + dv * scale);
    const h = Math.round(start.h + dh * scale);
    return {
        v: Math.max(1, Math.min(GRID_HEIGHT, v)),
        h: Math.max(1, Math.min(GRID_WIDTH, h)),
    };
}

function traceTorpedoPath(player: Player, start: Point, target: Point): TorpedoCollision {

    if (!isInBounds(start.v, start.h) || !isInBounds(target.v, target.h)) {
        sendMessageToClient(player, `Start ${JSON.stringify(start)} or target ${JSON.stringify(target)} is outside grid boundaries`);
        return null;
    }

    const { v: endV, h: endH } = clampPointWithinRange(start, target, MAX_TORPEDO_RANGE);
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

    // No collision, reached the travel limit/boundary
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

function toCollisionPayload(coll: TorpedoCollision): TorpedoEventPayload["collision"] {
    if (!coll) return { kind: "none" as const };
    switch (coll.type) {
        case "ship":
            return {
                kind: "ship" as const,
                name: coll.player.ship!.name,
                side: coll.player.ship!.side,
                position: { ...coll.player.ship!.position },
            };
        case "planet":
            return coll.planet.isBase
                ? { kind: "base" as const, name: coll.planet.name, side: coll.planet.side, position: { ...coll.planet.position } }
                : { kind: "planet" as const, name: coll.planet.name, side: coll.planet.side, position: { ...coll.planet.position } };
        case "star":
            return { kind: "star" as const, position: { ...coll.star.position } };
        case "blackhole":
            return { kind: "blackhole" as const, position: { ...coll.blackhole.position } };
        case "boundary":
            return { kind: "boundary" as const, position: { ...coll.point } };
        case "target":
            return { kind: "none" as const };
        default:
            return { kind: "none" as const };
    }
}

function emitBasicTorpedoEvent(
    attacker: Player,
    from: Point,
    aim: Point,
    coll: TorpedoCollision | null,
    extra?: {
        result?: TorpedoEventPayload["result"];
        damage?: number;
        shieldsBefore?: number;
        shieldsAfter?: number;
        killed?: boolean;
        novaTriggered?: boolean;
        crit?: { device?: string; amount?: number } | null;
    }
) {
    if (!attacker.ship) return;
    const collision = toCollisionPayload(coll);
    emitTorpedoEvent({
        by: { shipName: attacker.ship.name, side: attacker.ship.side },
        from: { v: from.v, h: from.h },
        aim: { v: aim.v, h: aim.h },
        collision,
        result: (extra?.result ?? "fizzled") as TorpedoEventPayload["result"],
        damage: extra?.damage,
        shieldsBefore: extra?.shieldsBefore,
        shieldsAfter: extra?.shieldsAfter,
        killed: !!extra?.killed,
        novaTriggered: !!extra?.novaTriggered,
        crit: extra?.crit ?? null,
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


        let fired = false;
        switch (collision?.type) {
            case "ship": {
                const victim = collision.player;

                // --- SPECIAL CASE: ROMULAN uses separate 'erom' (not ship.energy/damage) ---
                if (victim.ship?.romulanStatus?.isRomulan) {
                    const atk = player.ship!;
                    // Capture position BEFORE any destroy-side effects
                    const rpos = victim.ship.position ? { ...victim.ship.position } : { v: target.v, h: target.h };
                    const { ihita, killed } = applyRomulanTorpedoHitFrom();
                    // Visible scaling (Romulan routines are ~×10 larger internally)
                    const shown = Math.max(1, Math.round(ihita / 10));

                    // Attacker feedback + normal torpedo event for loggers/UI
                    addPendingMessage(player, `Direct torpedo hit on ROMULAN for ${shown}!`);
                    emitBasicTorpedoEvent(
                        player,
                        atk.position,
                        target,
                        collision,
                        { result: "hit", damage: shown, killed }
                    );

                    if (killed) {
                        emitRomulanDestroyed(rpos, attackerRef(player));
                    }

                    fired = true;
                    break; // Skip normal ship damage path
                }
                // --- /ROMULAN SPECIAL CASE ---

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

                emitBasicTorpedoEvent(
                    player,
                    player.ship.position,
                    target,
                    collision,
                    {
                        result: res.deflected ? "deflected" : (res.hita > 0 ? "hit" : "no_effect"),
                        damage: res.hita,
                        shieldsBefore,
                        shieldsAfter: victim.ship!.shieldEnergy,
                        killed: !!res.isDestroyed,
                        crit: res.critdm ? { device: res.critDeviceName ?? "DEVICE", amount: res.critdm } : null
                    }
                );

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

                const line = formatTorpedoShipHit({
                    attackerInitial,
                    targetInitial,
                    atkPos: atk.position,
                    offset: off,
                    beforePct,
                    damageUnits: dmg,
                    deflected: !!res.deflected,
                    deflectTo: res.deflectTo ?? null,
                    deltaPct,
                    critDeviceName: res.critDeviceName,
                    output: getOutputSetting(player)
                });
                sendMessageToClient(player, line);

                // victim gets a shorter "you were hit" note (your choice)
                addPendingMessage(victim, `${atk.name} torpedo ${dmg} on you${res.critdm ? " (CRIT)" : ""}.`);

                if (res.isDestroyed) checkEndGame();
                break;
            }



            case "planet": {
                const p = collision.planet;
                const wasBase = p.isBase; // capture role before damage (torpedoDamage may flip it)

                // Distress like FORTRAN when base is first struck at full shields
                if (p.isBase && p.energy === 1000) {
                    for (const other of players) {
                        if (!other.ship) continue;
                        if (other.ship.side === p.side) {
                            addPendingMessage(other, `Starbase ${p.position.v}-${p.position.h} is under torpedo fire!`);
                        }
                    }
                }

                // (optional) capture before if you want it; event only needs after/damage
                // const energyBefore = p.energy;

                const res = torpedoDamage(player, p); // may collapse base and undock internally

                emitBasicTorpedoEvent(
                    player,
                    player.ship.position,
                    target,
                    collision,
                    {
                        result: res.hita > 0 ? "hit" : "no_effect",
                        damage: res.hita,
                        shieldsBefore: p.isBase ? (/* before value if you cached it */ undefined) : undefined,
                        shieldsAfter: p.isBase ? p.energy : undefined,
                        killed: !!res.isDestroyed,
                        crit: res.critdm ? { device: "BASE", amount: res.critdm } : null
                    }
                );
                fired = true;

                // emit per-impact planet/base damage event
                emitPlanetHit(p, "torpedo", res.hita, res.isDestroyed, player);

                const coords = ocdefCoords(player.settings.ocdef, player.ship.position, p.position);
                const out = getOutputSetting(player);
                if (res.isDestroyed) {
                    // destruction messaging independent of current p.isBase (it may already be flipped)
                    sendMessageToClient(player, formatPlanetDestroyed(out, wasBase, coords));
                    checkEndGame();
                } else if (wasBase) {
                    // base was hit but survived this shot
                    sendMessageToClient(player, formatBaseHit(out, coords, res.hita, !!res.critdm));
                } else {
                    // Non-base planet (FORTRAN parity):
                    // 25% chance -> decrement builds; if builds < 0 after the hit, the planet is destroyed
                    if (ran() >= 0.75) {
                        p.builds = p.builds - 1; // allow negative so we can detect destruction when starting at 0

                        if (p.builds < 0) {
                            pointsManager.addPlanetsDestroyed(-1000, player, player.ship.side); // −1000 penalty

                            const planetIdx = planets.indexOf(p);
                            if (planetIdx !== -1) planets.splice(planetIdx, 1);

                            const ownerBases = p.side === "FEDERATION" ? bases.federation : bases.empire;
                            const bIdx = ownerBases.indexOf(p);
                            if (bIdx !== -1) ownerBases.splice(bIdx, 1);
                            p.isBase = false;

                            emitPlanetHit(p, "torpedo", 0, /*destroyed*/ true, player);
                            sendMessageToClient(player, formatPlanetDestroyed(out, /*wasBase*/ false, coords, /*planetPenalty*/ true));
                            checkEndGame();
                            break;
                        } else {
                            sendMessageToClient(player, formatPlanetInfra(out, coords));
                        }
                    } else {
                        sendMessageToClient(player, formatPlanetNoEffect(out, coords));
                    }
                }
                break;
            }

            case "star": {
                const { v, h } = collision.star.position;

                // player-facing text
                sendMessageToClient(player, formatTorpedoExplosion(player, v, h));

                // outcome: 80% nova
                const didNova = ran() < 0.8;
                if (didNova) {
                    // emit event first for consistent telemetry with Romulan path
                    const at: GridCoord = { v, h };
                    gameEvents.emit({
                        type: "nova_triggered",
                        payload: { at, by: attackerRef(player) },
                    });
                    triggerNovaAt(player, v, h);
                }

                // authoritative torpedo event AFTER outcome is known
                emitBasicTorpedoEvent(
                    player,
                    player.ship.position,  // from
                    target,                // aim (absolute, as you already computed)
                    collision,             // { type: "star", star: ... }
                    {
                        result: didNova ? "hit" : "no_effect", // "hit" = did something meaningful (nova)
                        damage: 0,                              // star/nova doesn’t deal torp “hull” damage directly
                        novaTriggered: didNova
                    }
                );

                fired = true;
                break;
            }

            case "blackhole":
                sendMessageToClient(player, formatTorpedoLostInVoid(player, collision.blackhole.position.v, collision.blackhole.position.h));
                fired = true;
                emitBasicTorpedoEvent(
                    player,
                    player.ship.position,
                    target,
                    collision,
                    { result: "no_effect", damage: 0 }
                );
                break;

            case "boundary": {
                const { v, h } = collision.point;
                sendMessageToClient(player, `Torpedo flew off to ${ocdefCoords(player.settings.ocdef, player.ship.position, { v, h })} and detonated harmlessly.`);
                fired = true;
                emitBasicTorpedoEvent(
                    player,
                    player.ship.position,
                    target,
                    collision,
                    { result: "out_of_range", damage: 0 }
                );
                break;
            }

            default:
                sendMessageToClient(player, `Torpedo failed to reach target.`);
                emitBasicTorpedoEvent(
                    player,
                    player.ship.position,
                    target,
                    null,
                    { result: "fizzled", damage: 0 }
                );
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
            const captureDelayMs = 2000 + ran() * 2000 + player.ship.devices.torpedo / 100;
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

    const output = getOutputSetting(player);
    switch (output) {
        case "SHORT":
            return `F > ${coords} No impact`;
        case "MEDIUM":
            return `Torpedo did not reach ${coords} `;
        case "LONG":
        default:
            return `Torpedo launch aborted. Target at ${coords} is beyond maximum range.`;
    }
}
function formatTorpedoLostInVoid(player: Player, v: number, h: number): string {
    const coords = ocdefCoords(player.settings.ocdef, player.ship?.position ?? { v: 0, h: 0 }, { v, h });

    const output = getOutputSetting(player);
    switch (output) {
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

    const output = getOutputSetting(player);
    switch (output) {
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
    const output = getOutputSetting(player);
    switch (output) {
        case "SHORT":
            return `F > ${coords} `;
        case "MEDIUM":
            return `Torpedo launched toward ${coords} `;
        case "LONG":
        default:
            return `${player.ship?.name ?? "Unknown"} has launched a torpedo toward ${coords}.`;
    }
}

// ---------------- Planet/Base impact formatters honoring OutputSetting -----
function formatPlanetNoEffect(output: OutputSetting, coords: string): string {
    switch (output) {
        case "SHORT": return `F > ${coords} no effect`;
        case "MEDIUM": return `Torpedo impact at ${coords} had no significant effect.`;
        case "LONG":
        default: return `Torpedo impact on planet @${coords} had no significant effect.`;
    }
}

function formatPlanetInfra(output: OutputSetting, coords: string): string {
    switch (output) {
        case "SHORT": return `F > ${coords} infra −1`;
        case "MEDIUM": return `Infrastructure disrupted at ${coords} (−1 builds).`;
        case "LONG":
        default: return `Torpedo impact on planet @${coords} disrupted infrastructure (−1 builds).`;
    }
}

function formatPlanetDestroyed(output: OutputSetting, wasBase: boolean, coords: string, penalized = false): string {
    if (wasBase) {
        switch (output) {
            case "SHORT": return `F > ${coords} BASE DESTROYED`;
            case "MEDIUM": return `Base destroyed @${coords}!`;
            case "LONG":
            default: return `Torpedo destroyed the base @${coords}!`;
        }
    } else {
        switch (output) {
            case "SHORT": return `F > ${coords} PLANET DESTROYED${penalized ? " (−1000)" : ""}`;
            case "MEDIUM": return `Planet destroyed @${coords}!${penalized ? " (−1000)" : ""}`;
            case "LONG":
            default: return `Torpedo destroyed the planet @${coords}!${penalized ? " (−1000)" : ""}`;
        }
    }
}

function formatBaseHit(output: OutputSetting, coords: string, dmg: number, crit: boolean): string {
    const d = Math.round(dmg);
    switch (output) {
        case "SHORT":
            return `F > ${coords} ${d > 0 ? `B −${d}` : `DEFLECT`}${crit ? " CRIT" : ""}`;
        case "MEDIUM":
            return d > 0
                ? `Base hit @${coords} for ${d}${crit ? " (CRIT)" : ""}.`
                : `Torpedo was deflected @${coords}${crit ? " (CRIT)" : ""}.`;
        case "LONG":
        default:
            return d > 0
                ? `Torpedo hit base @${coords} for ${d} damage${crit ? " (CRIT)" : ""}.`
                : `Torpedo was deflected @${coords}${crit ? " (CRIT)" : ""}.`;
    }
}
// --------------------------------------------------------------------------

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
    const hit = 4000.0 + 4000.0 * ran();
    const rana = ran();

    // Deflection test (ONLY when shields are actually up)
    if (shieldsUp && shieldPct > 0) {
        const rand = ran();
        const rand2 = rana - (shieldPct * 0.001 * rand) + 0.1;

        if (rand2 <= 0.0) {
            // Deflected: drain some shields (50 * rana on 0..1000 scale)
            let drain = 50.0 * rana;
            // Round so it never prints as 0 after Math.round
            if (drain > 0 && drain < 1) drain = 1;
            shieldPct = clamp(shieldPct - drain, 0, 1000);
            rawShieldEnergy = fromPct(shieldPct, rawShieldMax);

            if (isPlayer) {
                target.ship!.shieldEnergy = rawShieldEnergy;
                addPendingMessage(target, `Your shields deflected a torpedo (−${Math.round(drain)} shield).`);
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
        const rana2 = ran();
        const extra = 50 + Math.floor(100 * rana2); // 50..149
        (target as Planet).energy = Math.max(0, (target as Planet).energy - extra);
        critdm = 1;

        if (ran() < 0.10 || (target as Planet).energy <= 0) {
            // Base killed via collapse: award and remove
            // (ensure you have this import somewhere near the top of the file)
            // import { gameEvents } from "./api/events.js";

            if (source instanceof Player && source.ship) {
                const atkSide = source.ship.side;
                const tgtSide = (target as Planet).side;
                const sign = atkSide !== tgtSide ? 1 : -1;

                (pointsManager as unknown as ScoringAPI).addDamageToBases?.(10000 * sign, source, atkSide);
            }

            // --- base removal / collapse (single emit) ---
            {
                const base = target as Planet;
                const prevSide = base.side; // capture before mutation

                // Remove from owning side's base list
                const arr = prevSide === "FEDERATION" ? bases.federation : bases.empire;
                const idx = arr.indexOf(base);
                if (idx !== -1) arr.splice(idx, 1);

                // Remove from global planets as well (no demotion)
                const pidx = planets.indexOf(base);
                if (pidx !== -1) planets.splice(pidx, 1);

                // BASKIL parity: undock/RED ships that were using this port
                handleUndockForAllShipsAfterPortDestruction(base);

                gameEvents.emit({
                    type: "planet_base_removed",
                    payload: {
                        planet: {
                            name: base.name,
                            previousSide: prevSide,
                            position: { ...base.position },
                            // informational only; object is removed
                            energy: 0,
                            builds: 0,
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
            critdm = Math.max(critdm, Math.round(crit.critdm * TORP_HULL_SCALE));

            const deviceKeys = Object.keys(victim.ship!.devices);
            const deviceName = deviceKeys[crit.critdv]?.toUpperCase?.() ?? "DEVICE";

            // Show scaled device damage (same scale as hull), or omit number.
            const scaledCrit = Math.max(0, Math.round(crit.critdm * TORP_HULL_SCALE));
            addPendingMessage(
                victim,
                scaledCrit > 0
                    ? `CRITICAL HIT: ${deviceName} damaged (${scaledCrit}).`
                    : `CRITICAL HIT: ${deviceName} struck!`
            );
        } else {
            // Non-crit: integer hull like the original (no global jitter)
            hita = Math.max(0, Math.round(hita));
        }
    }

    // Scale raw torp impact into hull units (~×0.1) before applying/scoring
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
            // Award ship-kill bonus ONCE per victim hull.
            if (target.ship && !target.ship.__killCredited) {
                target.ship.__killCredited = true;
                const sign = atkSide !== target.ship!.side ? 1 : -1;
                (pointsManager as unknown as ScoringAPI).addDamageToEnemies?.(5000 * sign, source, atkSide);
            }
        } else if (isBase) {
            const sign = atkSide !== (target as Planet).side ? 1 : -1;
            (pointsManager as unknown as ScoringAPI).addDamageToBases?.(10000 * sign, source, atkSide);
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
        const wasAlive = target.ship.damage < SHIP_FATAL_DAMAGE;
        target.ship.energy -= hita;
        target.ship.damage += hita / 2;

        // Clamp to avoid negative telemetry
        if (target.ship.energy < 0) target.ship.energy = 0;

        if (target.ship.energy <= 0 || target.ship.damage >= SHIP_FATAL_DAMAGE) {
            isDestroyed = true;
            // Award kill credit if this hit destroyed the ship
            if (source instanceof Player && source.ship && wasAlive) {
                pointsManager.creditShipKill(source, target.ship.side, 500);
            }
            emitShipDestroyed(
                target.ship.name,
                target.ship.side,
                { v: target.ship.position.v, h: target.ship.position.h },
                source instanceof Player ? attackerRef(source) : undefined,
                "combat"
            );
            removePlayerFromGame(target);
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

            // capture before removal
            const prevSide = target.side;

            // remove from owner's base list
            const arr = prevSide === "FEDERATION" ? bases.federation : bases.empire;
            const idx = arr.indexOf(target);
            if (idx !== -1) arr.splice(idx, 1);

            // remove from global planets (no demotion)
            const pidx = planets.indexOf(target);
            if (pidx !== -1) planets.splice(pidx, 1);

            // undock ships that were using this port (BASKIL parity)
            handleUndockForAllShipsAfterPortDestruction(target);

            // emit with captured previous side
            gameEvents.emit({
                type: "planet_base_removed",
                payload: {
                    planet: {
                        name: target.name,
                        previousSide: prevSide,
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

