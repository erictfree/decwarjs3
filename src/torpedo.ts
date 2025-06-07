import { Player } from './player.js';
import { Command } from './command.js';
import { addPendingMessage, putClientOnHold, releaseClient, sendMessageToClient, sendMessageToOthers } from './communication.js';
import {
    MAX_SHIELD_ENERGY,
    MAX_TORPEDO_RANGE,
    GRID_HEIGHT,
    GRID_WIDTH,
    OutputSetting,
    CoordMode
} from './settings.js';
import { Planet } from './planet.js';
import { isInBounds, bresenhamLine, chebyshev, ocdefCoords } from './coords.js';
//import { triggerNovaAt } from './nova.js'; TODO
import { disconnectTractorWithReason } from './tractor.js';
import { players, bases, planets, stars, blackholes } from './game.js';
import { handleUndockForAllShipsAfterPortDestruction, attemptDisplaceFromImpact } from './ship.js';

const TORPEDO_MIN_HIT = 4000;
const TORPEDO_MAX_HIT = 8000;

type Point = { v: number; h: number };

type TorpedoCollision =
    | { type: "ship"; player: Player }
    | { type: "planet"; planet: Planet }
    | { type: "star" }
    | { type: "blackhole" }
    | { type: "target"; point: Point } // reached target with no collision
    | { type: "boundary"; point: Point } // reached grid boundary
    | null;


function traceTorpedoPath(start: Point, target: Point): TorpedoCollision {

    if (!isInBounds(start.v, start.h) || !isInBounds(target.v, target.h)) {
        throw new Error(`Start ${JSON.stringify(start)} or target ${JSON.stringify(target)} is outside grid boundaries`); //TODO
    }

    // Calculate direction vector
    const dv = target.v - start.v;
    const dh = target.h - start.h;

    // If start and target are the same, return the point
    if (dv === 0 && dh === 0) {
        return { type: "target", point: target }; // Already validated as in-bounds
    }

    // Find the parameter t where the line exits the grid
    const tMinV = dv !== 0 ? (1 - start.v) / dv : Infinity;
    const tMaxH = dh !== 0 ? (GRID_WIDTH - start.h) / dh : Infinity;
    const tMinH = dv !== 0 ? (1 - start.h) / dh : Infinity;
    const tMaxV = dv !== 0 ? (GRID_HEIGHT - start.v) / dv : Infinity;

    // Find the smallest positive t that hits a boundary
    let tBoundary = Infinity;
    if (dh > 0) tBoundary = Math.min(tBoundary, tMaxH);
    else if (dh < 0) tBoundary = Math.min(tBoundary, tMinH);
    if (dv > 0) tBoundary = Math.min(tBoundary, tMaxV);
    else if (dv < 0) tBoundary = Math.min(tBoundary, tMinV);

    // Calculate the boundary point
    let endH = Math.round(start.h + tBoundary * dh);
    let endV = Math.round(start.v + tBoundary * dv);

    // Clamp to grid boundaries
    endV = Math.max(1, Math.min(GRID_HEIGHT, endV));
    endH = Math.max(1, Math.min(GRID_WIDTH, endH));

    // Generate points along the line from start to the boundary
    const points = bresenhamLine(start.v, start.h, endV, endH);
    let skipFirst = true;

    for (const { v, h } of points) {
        if (skipFirst) {
            skipFirst = false;
            continue; // Skip the attacker's own position
        }

        // Verify point is within grid (defensive check)
        if (!isInBounds(v, h)) {
            throw new Error(`Bresenham point (${v}, ${h}) is outside grid boundaries`);  //TODO
        }

        // Check for ship
        const ship = players.find(p => p.ship && p.ship.position.v === v && p.ship.position.h === h);
        if (ship) return { type: "ship", player: ship };

        // Check for planet
        const planet = planets.find(p => p.position.h === h && p.position.v === v);
        if (planet) return { type: "planet", planet: planet };

        // Check for star
        if (stars.some(star => star.position.v === v && star.position.h === h)) {
            return { type: "star" };
        }

        // Check for black hole
        if (blackholes.some(bh => bh.position.v === v && bh.position.h === h)) {
            return { type: "blackhole" };
        }
    }

    // No collision, reached the grid boundary
    const boundaryPoint = { v: endV, h: endH };
    if (!isInBounds(boundaryPoint.v, boundaryPoint.h)) {
        throw new Error(`Boundary point ${JSON.stringify(boundaryPoint)} is outside grid boundaries`);
    }
    return { type: "boundary", point: boundaryPoint };
}
// function traceTorpedoPath(start: Point, target: Point): TorpedoCollision {
//     const points = bresenhamLine(start.x, start.y, target.x, target.y);
//     let skipFirst = true;

//     for (const { x, y } of points) {
//         if (skipFirst) {
//             skipFirst = false;
//             continue; // skip the attacker's own position
//         }

//         // Check for ship
//         const ship = players.find(p => p.alive && p.ship.position.x === x && p.ship.position.y === y);
//         if (ship) return { type: "ship", player: ship };

//         // Check for planet
//         const planet = planets.find(p => p.position.x === x && p.position.y === y);
//         if (planet) return { type: "planet", planet: planet };

//         const empireBase = bases.empire.find(b => b.position.x === x && b.position.y === y);
//         if (empireBase) {
//             return { type: "base", base: empireBase };
//         }

//         const federationBase = bases.federation.find(b => b.position.x === x && b.position.y === y);
//         if (federationBase) {
//             return { type: "base", base: federationBase };
//         }

//         // Check for star
//         if (stars.some(star => star.x === x && star.y === y)) {
//             return { type: "star" };
//         }

//         // Check for black hole
//         if (blackHoles.some(bh => bh.x === x && bh.y === y)) {
//             return { type: "blackhole" };
//         }
//     }

//     // No collision, reached intended target
//     return { type: "target", point: target };ddddd
// }

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

        const collision = traceTorpedoPath(player.ship.position, target);
        let fired = false;
        switch (collision?.type) {
            case "ship":
                torpedoShip(player, collision.player, i + 1);
                fired = true;
                break;
            case "planet":
                if (collision.planet.isBase) {
                    applyTorpedoBaseDamage(player, collision.planet, i + 1);
                } else {
                    applyTorpedoPlanetDamage(player, collision.planet, i + 1);
                }
                fired = true;
                break;
            case "blackhole":
                sendMessageToClient(player, formatTorpedoLostInVoid(player, target.v, target.h));
                fired = true;
                break;
            case "star":
                sendMessageToClient(player, formatTorpedoExplosion(player, target.v, target.h));
                if (Math.random() > 0.8) {
                    player.points.starsDestroyed += 1;
                    //triggerNovaAt(player, target.v, target.h);
                }
                fired = true;
                break;
            case "target": {
                const { v, h } = collision.point;
                const finalTarget =
                    players.find(p => p.ship && p.ship.position.h === h && p.ship.position.v === v) ||
                    planets.find(p => p.position.h === h && p.position.v === v);

                if (!finalTarget) {
                    sendMessageToClient(player, formatTorpedoMissed(player, v, h));
                    break;
                }

                if (finalTarget instanceof Player) torpedoShip(player, finalTarget, i + 1);
                else if (finalTarget instanceof Planet && finalTarget.isBase) applyTorpedoBaseDamage(player, finalTarget, i + 1);
                else if (finalTarget instanceof Planet) applyTorpedoPlanetDamage(player, finalTarget, i + 1);
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
}

const DESTRUCTION_DAMAGE_THRESHOLD = 2500;

export function torpedoShip(attacker: Player, target: Player, n: number): void {
    if (!target.ship) {
        sendMessageToClient(attacker, `Target already destroyed.`);
        return;
    }
    if (!attacker.ship) {
        sendMessageToClient(attacker, `You must be in a ship to fire torpedoes.`);
        return;
    }

    if (target.ship.side == attacker.ship.side) {
        const coords = ocdefCoords(attacker.settings.ocdef, attacker.ship.position, { v: target.ship.position.v, h: target.ship.position.h })
        sendMessageToClient(attacker, `Weapons Officer: Captain, torpedo ${n} neutralized by friendly object ${coords}`);
        return;
    }

    const hit = TORPEDO_MIN_HIT + Math.random() * (TORPEDO_MAX_HIT - TORPEDO_MIN_HIT);

    disconnectTractorWithReason(target.ship, "torpedo");

    applyTorpedoShipDamage(target, attacker, hit, true);

    // Show hit info to attacker using formatted message (optional if `applyTorpedoShipDamage` already does this)
    sendMessageToClient(attacker, `Torpedo fired at ${target.ship.name} — estimated ${Math.round(hit)} damage.`);

    // DECWAR: side-effect from torpedo impact (push/displace)
    attemptDisplaceFromImpact(attacker, target);
}

export function applyTorpedoPlanetDamage(attacker: Player, planet: Planet, n: number): void {
    if (!attacker.ship) {
        sendMessageToClient(attacker, `You must be in a ship to fire torpedoes.`);
        return;
    }
    if (planet.side == attacker.ship.side) {
        const coords = ocdefCoords(attacker.settings.ocdef, attacker.ship.position, planet.position);
        sendMessageToClient(attacker, `Weapons Officer: Captain, torpedo ${n} neutralized by friendly object ${coords}`);
        return;
    }

    if (planet.builds <= 0) {
        sendMessageToClient(attacker, "Planet already destroyed."); //TODO
        return;
    }

    const hit = 4000 + 4000 * Math.random();
    const rana = Math.random();

    const shieldStrength = planet.builds * 200;
    const maxPlanetShield = 30 * 200; // assuming 30 builds is max
    const { effectiveDamage, shieldLoss } = calculateShieldedDamage(hit, shieldStrength, maxPlanetShield);
    const newShieldStrength = Math.max(0, shieldStrength - shieldLoss);
    planet.builds = Math.floor(newShieldStrength / 200);

    const isCritical = effectiveDamage * (rana + 0.1) >= 1700;
    const randomKill = Math.floor(Math.random() * 10) === 0;
    const coords = `${planet.position.v} - ${planet.position.h}`;

    const message = formatTorpedoPlanetHit({
        attackerName: attacker.ship.name ?? "Unknown",
        planet,
        remainingBuilds: planet.builds,
        outputLevel: attacker.settings.output
    });

    sendMessageToClient(attacker, message);

    if (planet.builds <= 0 || (isCritical && randomKill)) {
        planet.builds = 0;
        planet.side = "NEUTRAL";

        attacker.points.planetsDestroyed += 1;
        sendMessageToClient(attacker, `Planet at ${coords} destroyed!`);
        handleUndockForAllShipsAfterPortDestruction(planet);
        //removeFromMemory(planet); TODO
    }
}

export function applyTorpedoBaseDamage(attacker: Player, base: Planet, n: number): void {
    if (!attacker.ship) {
        sendMessageToClient(attacker, `You must be in a ship to fire torpedoes.`);
        return;
    }
    if (base.side == attacker.ship.side) {
        const coords = ocdefCoords(attacker.settings.ocdef, attacker.ship.position, base.position);
        sendMessageToClient(attacker, `Weapons Officer: Captain, torpedo ${n} neutralized by friendly object ${coords}`);
        return;
    }
    const hit = 4000 + 4000 * Math.random();
    const rana = Math.random();

    if (base.strength === 1000 && !base.hasCriedForHelp) {
        base.hasCriedForHelp = true;
        base.callForHelp(base.position.v, base.position.h, base.side);
    }

    const { effectiveDamage, shieldLoss } = calculateShieldedDamage(hit, base.strength, 1000);
    base.strength = Math.max(0, base.strength - shieldLoss);

    const isCritical = effectiveDamage * (rana + 0.1) >= 1700;
    const randomKill = Math.floor(Math.random() * 10) === 0;
    const shouldDestroy = base.strength <= 0 || (isCritical && randomKill);

    const coords = `${base.position.v} - ${base.position.h}`;
    const damageMessage = formatTorpedoBaseHit({
        attackerName: attacker.ship.name ?? "Unknown",
        base,
        damage: hit,
        outputLevel: attacker.settings.output
    });

    sendMessageToClient(attacker, damageMessage);

    if (shouldDestroy) {
        const baseList = base.side === "FEDERATION" ? bases.federation : bases.empire;
        const index = baseList.indexOf(base);
        console.log("index: " + index);
        if (index !== -1) baseList.splice(index, 1);
        //removeFromMemory(base); TODO
        //attacker.points.basesDestroyed += 1; TODO
        sendMessageToClient(attacker, `The ${base.side} base at ${coords} has been destroyed!`);

        handleUndockForAllShipsAfterPortDestruction(base);

        sendMessageToClient(attacker, "Base destroyed.");
    } else {
        sendMessageToClient(attacker, "Base damaged.");
    }
}

export function applyTorpedoShipDamage(
    target: Player,
    attacker: Player | Planet,
    rawDamage: number,
    allowDeviceCrit: boolean = true,
    n: number = 1
): void {
    if (!target.ship) {
        return;
    }
    if (attacker instanceof Player && !attacker.ship) {
        return;  //TODO
    }

    if (
        (attacker instanceof Player && attacker.ship && target.ship.side === attacker.ship.side) ||
        (attacker instanceof Planet && target.ship.side === attacker.side)
    ) {
        if (attacker instanceof Player && attacker.ship) {
            const coords = ocdefCoords(attacker.settings.ocdef, attacker.ship.position, { v: target.ship.position.v, h: target.ship.position.h });
            sendMessageToClient(attacker, `Weapons Officer: Captain, torpedo ${n} neutralized by friendly object ${coords}`);
        }
        return;

    }
    const shieldLevel = target.ship.level;
    let finalDamage = rawDamage;

    if (target.ship.shieldsUp && shieldLevel > 0) {
        const { effectiveDamage, shieldLoss } = calculateShieldedDamage(rawDamage, shieldLevel, MAX_SHIELD_ENERGY);
        finalDamage = effectiveDamage;
        target.ship.level = Math.max(0, shieldLevel - shieldLoss);
    }

    if (attacker instanceof Player) {
        if (target.ship.romulanStatus?.isRomulan) {
            attacker.points.damageToRomulans += finalDamage;
        } else {
            attacker.points.damageToEnemies += finalDamage;
        }
    }

    target.ship.energy -= finalDamage;
    target.ship.damage += finalDamage / 2;

    // Critical hit to a random device
    if (allowDeviceCrit && Math.random() < 0.2) {
        const deviceKeys = Object.keys(target.ship.devices) as (keyof typeof target.ship.devices)[];
        const randomDevice = deviceKeys[Math.floor(Math.random() * deviceKeys.length)];
        const critDamage = Math.floor(finalDamage * 0.5);
        target.ship.devices[randomDevice] = Math.min(target.ship.devices[randomDevice] + critDamage, 1000);
        addPendingMessage(target, `CRITICAL HIT: ${randomDevice} damaged(${critDamage})!`);
    }

    const attackerName = attacker instanceof Player
        ? attacker.ship?.name ?? "Unknown"
        : `${attacker.side} ${"builds" in attacker ? "planet" : "starbase"} at ${attacker.position.v} - ${attacker.position.h}`;

    const attackerOutputLevel = attacker instanceof Player ? attacker.settings.output : "LONG";
    const targetOutputLevel = target.settings.output;
    const targetPos = target.ship.position;

    const attackerMessage = formatTorpedoShipHit({
        attackerName,
        targetName: target.ship.name ?? "Unknown",
        targetPos,
        damage: finalDamage,
        outputLevel: attackerOutputLevel
    });

    const targetMessage = formatTorpedoShipHit({
        attackerName,
        targetName: target.ship.name ?? "Unknown",
        targetPos,
        damage: finalDamage,
        outputLevel: targetOutputLevel
    });

    if (attacker instanceof Player) {
        sendMessageToClient(attacker, attackerMessage);
    }
    addPendingMessage(target, targetMessage);

    // Handle ship destruction
    if (target.ship.energy <= 0 || target.ship.damage >= DESTRUCTION_DAMAGE_THRESHOLD) {
        if (attacker instanceof Player && target.ship.romulanStatus?.isRomulan) {
            //attacker.points.romulansDestroyed += 1; TODO
        }

        target.ship.energy = 0;//TODO
        target.ship.isDestroyed = true;

        addPendingMessage(target, `You have been destroyed by ${attackerName}.`);
        //putPlayerInLimbo(target, true); TODO

        if (attacker instanceof Player) {
            sendMessageToClient(attacker, `${target.ship.name} destroyed by torpedo hit!`);
            // attacker.points.shipsDestroyed += 1;
        }

    }
}

export function formatTorpedoShipHit({
    attackerName,
    targetName,
    targetPos,
    damage,
    outputLevel
}: {
    attackerName: string;
    targetName: string;
    targetPos: { v: number; h: number };
    damage: number;
    outputLevel: OutputSetting;
}): string {
    const coords = `${targetPos.v} - ${targetPos.h}`;
    const dmg = Math.round(damage);

    switch (outputLevel) {
        case "SHORT":
            return `${attackerName[0]} > ${targetName[0]} @${coords} ${dmg}`;
        case "MEDIUM":
            return `${attackerName} torpedo hit ${targetName} @${coords} ${dmg}`;
        case "LONG":
        default:
            return `${attackerName} fired torpedo and hit ${targetName} at ${coords} for ${dmg} damage.`;
    }
}

export function formatTorpedoBaseHit({
    attackerName,
    base,
    damage,
    outputLevel
}: {
    attackerName: string;
    base: Planet;
    damage: number;
    outputLevel: OutputSetting;
}): string {
    const coords = `${base.position.v} -${base.position.h} `;
    const dmg = Math.round(damage);

    switch (outputLevel) {
        case "SHORT":
            return `${attackerName[0]} > ${base.side[0]}B @${coords} ${dmg} `;
        case "MEDIUM":
            return `${attackerName} hit ${base.side} base @${coords} ${dmg} `;
        case "LONG":
        default:
            return `${attackerName} fired torpedo at ${base.side} base at ${coords}, causing ${dmg} damage.`;
    }
}

export function formatTorpedoPlanetHit({
    attackerName,
    planet,
    remainingBuilds,
    outputLevel
}: {
    attackerName: string;
    planet: Planet;
    remainingBuilds: number;
    outputLevel: OutputSetting;
}): string {
    const coords = `${planet.position.v} -${planet.position.h} `;

    switch (outputLevel) {
        case "SHORT":
            return `${attackerName[0]} > P @${coords} ${remainingBuilds} B`;
        case "MEDIUM":
            return `${attackerName} torpedoed planet @${coords}, builds left: ${remainingBuilds} `;
        case "LONG":
        default:
            return `${attackerName} struck planet at ${coords} with torpedo. Remaining builds: ${remainingBuilds} `;
    }
}

function calculateShieldedDamage(
    rawDamage: number,
    shieldValue: number,
    maxShieldValue: number = MAX_SHIELD_ENERGY
): {
    effectiveDamage: number;
    shieldLoss: number;
} {
    const shieldPercent = Math.max((1000 * shieldValue) / maxShieldValue, 0);
    const shieldFactor = Math.max(shieldPercent * 0.001, 0.1);
    const effectiveDamage = rawDamage * (1000 - shieldPercent) * 0.001;
    const shieldLoss = (rawDamage * shieldFactor + 10) * 0.03;

    return { effectiveDamage, shieldLoss };
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
            return `Torpedo disappeared at ${coords} `;
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
            return `Explosion at ${coords} !`;
        case "LONG":
        default:
            return `Torpedo triggered explosion at ${coords}. Unstable celestial mass may have ignited.`;
    }
}

function formatTorpedoMissed(player: Player, v: number, h: number): string {
    const coords = ocdefCoords(player.settings.ocdef, player.ship?.position ?? { v: 0, h: 0 }, { v, h });

    switch (player.settings.output) {
        case "SHORT":
            return `F > ${coords} Miss`;
        case "MEDIUM":
            return `Torpedo missed at ${coords} `;
        case "LONG":
        default:
            return `Torpedo reached ${coords} but hit nothing.`;
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

