import { Player } from './player.js';
import { Command } from './command.js';
import {
    addPendingMessage,
    putClientOnHold,
    releaseClient,
    sendMessageToClient,
    sendMessageToOthers,
    sendMessageToOthersWithFormat
} from './communication.js';
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
import { disconnectTractorWithReason } from './tractor.js';
import { players, bases, planets, stars, blackholes, pointsManager, removePlayerFromGame, checkEndGame } from './game.js';
import { handleUndockForAllShipsAfterPortDestruction, attemptDisplaceFromImpact } from './ship.js';
import { triggerNovaAt } from './nova.js';
import { Star } from './star.js';
import { Blackhole } from './blackhole.js';

const TORPEDO_MIN_HIT = 4000;
const TORPEDO_MAX_HIT = 8000;

type TorpedoCollision =
    | { type: "ship"; player: Player }
    | { type: "planet"; planet: Planet }
    | { type: "star"; star: Star }
    | { type: "blackhole"; blackhole: Blackhole }
    | { type: "target"; point: Point } // reached target with no collision
    | { type: "boundary"; point: Point } // reached grid boundary
    | null;

type Point = { v: number; h: number };

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
    console.log(start, target, { v: endV, h: endH });
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
        console.log("checking " + v + " " + h);
        const star = stars.find(star => star.position.v === v && star.position.h === h);
        if (star) {
            console.log("found star", star.position);
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

    console.log(targets);

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
            case "ship":
                console.log("TORPEDO OF SHIP", collision.player.ship?.position);
                torpedoShip(player, collision.player, i + 1);
                fired = true;
                break;
            case "planet":
                console.log("TORPEDO OF PLANET", collision.planet.position);
                if (collision.planet.isBase) {
                    applyTorpedoPlanetDamage(player, collision.planet, i + 1);
                } else {
                    applyTorpedoPlanetDamage(player, collision.planet, i + 1);
                }
                fired = true;
                break;
            case "star":
                console.log("TORPEDO OF STAR", target.v, target.h);
                sendMessageToClient(player, formatTorpedoExplosion(player, collision.star.position.v, collision.star.position.h));
                if (Math.random() > 0.8) {
                    triggerNovaAt(player, collision.star.position.v, collision.star.position.h);
                }
                fired = true;
                break;
            case "blackhole":
                console.log("TORPEDO OF BLACKHOLE", target.v, target.h);
                sendMessageToClient(player, formatTorpedoLostInVoid(player, collision.blackhole.position.v, collision.blackhole.position.h));
                fired = true;
                break;

            // case "target": {
            //     console.log("TORPEDO OF GENERIC");

            //     const { v, h } = collision.point;
            //     const finalTarget =
            //         players.find(p => p.ship && p.ship.position.h === h && p.ship.position.v === v) ||
            //         planets.find(p => p.position.h === h && p.position.v === v);

            //     if (!finalTarget) {
            //         sendMessageToClient(player, formatTorpedoMissed(player, v, h));
            //         break;
            //     }
            //     console.log("FINAL TARGET");
            //     if (finalTarget instanceof Player) torpedoShip(player, finalTarget, i + 1);
            //     else if (finalTarget instanceof Planet && finalTarget.isBase) applyTorpedoPlanetDamage(player, finalTarget, i + 1);
            //     else if (finalTarget instanceof Planet) applyTorpedoPlanetDamage(player, finalTarget, i + 1);
            //     fired = true;
            //     break;
            // }
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
    if (planet.side === attacker.ship.side) {
        const coords = ocdefCoords(attacker.settings.ocdef, attacker.ship.position, planet.position);
        sendMessageToClient(attacker, `Weapons Officer: Captain, torpedo ${n} neutralized by friendly object ${coords}`);
        return;
    }

    const coords = `${planet.position.v} - ${planet.position.h}`;

    if (!planet.isBase) {
        // Non-base planet: 25% chance to reduce builds (Fortran: iran(4) == 4)
        if (Math.floor(Math.random() * 4) === 0) { // 1/4 chance
            planet.builds = Math.max(0, planet.builds - 1);
        }

        const message = formatTorpedoPlanetHit({
            attackerName: attacker.ship.name ?? "Unknown",
            planet,
            remainingBuilds: planet.builds,
            outputLevel: attacker.settings.output
        });
        sendMessageToClient(attacker, message);

        // Planet destroyed
        if (planet.builds <= 0) {
            planet.builds = 0;
            pointsManager.addPlanetsDestroyed(1, attacker, attacker.ship.side); // -1000
            const planetIndex = planets.indexOf(planet);
            if (planetIndex !== -1) {
                planets.splice(planetIndex, 1);
            }
            sendMessageToClient(attacker, `Planet at ${coords} destroyed!`);
            handleUndockForAllShipsAfterPortDestruction(planet);
            checkEndGame();
        }
    } else {
        // Base: Use energy-based damage (TORDAM)
        const baseArray = planet.side === "FEDERATION" ? bases.federation : bases.empire;
        const base = baseArray.find(b => b.position.v === planet.position.v && b.position.h === planet.position.h);
        if (!base) return;

        // Distress call if undamaged (Fortran: base(j,3,nplc-2) == 1000)
        if (base.energy === 1000) {
            const distressMsg = attacker.settings.output === "SHORT"
                ? `BASE DST @${coords}`
                : `Base at ${coords} is under attack by torpedo!`;
            sendMessageToClient(attacker, distressMsg);
            sendMessageToOthersWithFormat(attacker, (recipient) => {
                const formatted = ocdefCoords("ABSOLUTE", recipient.ship?.position ?? { v: 0, h: 0 }, planet.position);
                return recipient.settings.output === "SHORT"
                    ? `BASE DST @${formatted}`
                    : `Base at ${formatted} is under attack by torpedo!`;
            });
        }

        // Damage calculation (from TORDAM)
        const hit = 4000 + 4000 * Math.random(); // 4000–8000
        const hita = hit * (1000 - base.energy) * 0.001; // Effective damage after shields
        base.energy = Math.max(0, Math.floor(base.energy - (hit * Math.max(base.energy * 0.001, 0.1) + 10) * 0.03));

        // Add damage-based points (Fortran: tpoint(KPBDAM) += hita)
        pointsManager.addDamageToBases(hita, attacker, attacker.ship.side);

        const message = formatTorpedoPlanetHit({
            attackerName: attacker.ship.name ?? "Unknown",
            planet,
            remainingBuilds: 0, // No builds for bases (Fortran doesn't use builds)
            outputLevel: attacker.settings.output
        });
        sendMessageToClient(attacker, message);

        // Critical hit (10% chance, Fortran: iran(10) == 10)
        if (Math.floor(Math.random() * 10) === 0) {
            base.energy = Math.max(0, base.energy - (50 + Math.random() * 100));
        }

        // Base destruction (energy <= 0)
        if (base.energy <= 0) {
            base.energy = 0;
            planet.isBase = false;
            const baseIdx = baseArray.indexOf(base);
            if (baseIdx !== -1) baseArray.splice(baseIdx, 1);
            pointsManager.addBasesBuilt(-1, attacker, attacker.ship.side); // -10000
            sendMessageToClient(attacker, `Base at ${coords} destroyed!`);
            handleUndockForAllShipsAfterPortDestruction(planet);
            checkEndGame();
        }
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

    if (base.energy === 1000 && !base.hasCriedForHelp) {
        base.hasCriedForHelp = true;
        base.callForHelp(base.position.v, base.position.h, base.side);
    }

    const { effectiveDamage, shieldLoss } = calculateShieldedDamage(hit, base.energy, 1000);
    base.energy = Math.max(0, base.energy - shieldLoss);

    const isCritical = effectiveDamage * (rana + 0.1) >= 1700;
    const randomKill = Math.floor(Math.random() * 10) === 0;

    const coords = `${base.position.v} - ${base.position.h}`;
    const damageMessage = formatTorpedoBaseHit({
        attackerName: attacker.ship.name ?? "Unknown",
        base,
        damage: hit,
        outputLevel: attacker.settings.output
    });

    sendMessageToClient(attacker, damageMessage);

    // destroy base
    if (base.energy <= 0 || (isCritical && randomKill)) {
        const baseList = base.side === "FEDERATION" ? bases.federation : bases.empire;
        const index = baseList.indexOf(base);
        console.log("index: " + index);
        if (index !== -1) baseList.splice(index, 1);
        //removeFromMemory(base); TODO
        pointsManager.addBasesBuilt(1, attacker, attacker.ship.side);
        sendMessageToClient(attacker, `The ${base.side} base at ${coords} has been destroyed!`);

        handleUndockForAllShipsAfterPortDestruction(base);

        sendMessageToClient(attacker, "Base destroyed.");

        checkEndGame();
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
    if (!target.ship || (attacker instanceof Player && !attacker.ship)) {
        return;
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
    const shieldLevel = target.ship.shieldEnergy;
    let finalDamage = rawDamage;

    if (target.ship.shieldsUp && shieldLevel > 0) {
        const { effectiveDamage, shieldLoss } = calculateShieldedDamage(rawDamage, shieldLevel, MAX_SHIELD_ENERGY);
        finalDamage = effectiveDamage;
        target.ship.shieldEnergy = Math.max(0, shieldLevel - shieldLoss);
    }

    if (attacker instanceof Player && attacker.ship) {
        if (target.ship.romulanStatus?.isRomulan) {
            pointsManager.addDamageToRomulans(finalDamage, attacker, attacker.ship.side);
        } else {
            pointsManager.addDamageToEnemies(finalDamage, attacker, attacker.ship.side);
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

        sendMessageToClient(target, `You have been destroyed by ${attackerName}.`, true, false); // sendmessage given needs to be delivered.
        removePlayerFromGame(target);
        sendMessageToClient(target, ``, true, true); // sendmessage given needs to be delivered.



        if (attacker instanceof Player) {
            if (attacker.ship) {
                pointsManager.addEnemiesDestroyed(1, attacker, attacker.ship.side);
            }
            sendMessageToClient(attacker, `${target.ship.name} destroyed by torpedo hit!`);
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
    const coords = `${planet.position.v} -${planet.position.h}`;

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

