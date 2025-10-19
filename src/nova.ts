import { sendMessageToClient, sendMessageToOthersWithFormat } from "./communication.js";
import { ran } from "./util/random.js";
import { players, stars, pointsManager, removePlayerFromGame, planets, bases, checkEndGame, blackholes } from "./game.js";
import { Player } from "./player.js";
import { ocdefCoords, isAdjacent } from "./coords.js";
import { disconnectTractorWithReason } from "./tractor.js";
import { Planet } from "./planet.js";
import { Ship } from "./ship.js";
import { emitShipUndocked, emitNovaTriggered, emitObjectDisplaced } from "./api/events.js";


// Check if a position is within the galaxy (Fortran: ingal)
function isInGalaxy(v: number, h: number): boolean {
    // Assuming galaxy is 0–99 for both v and h (adjust based on your game)
    return v >= 0 && v <= 99 && h >= 0 && h <= 99;
}

// Check if a position is empty or contains a black hole (Fortran: dispc)
function getPositionType(v: number, h: number): string {
    if (blackholes.some(bh => bh.position.v === v && bh.position.h === h)) {
        return "BLACK_HOLE";
    }

    if (
        players.some(p => p.ship && p.ship.position.v === v && p.ship.position.h === h) ||
        planets.some(p => p.position.v === v && p.position.h === h) ||
        bases.federation.some(b => b.position.v === v && b.position.h === h) ||
        bases.empire.some(b => b.position.v === v && b.position.h === h)
    ) {
        return "OCCUPIED";
    }
    return "EMPTY";
}

// Displace a ship or base to a new position (Fortran: setdsp)
function displaceObject(
    obj: Ship | Planet,
    newV: number,
    newH: number,
    reason: "nova" | "blackhole" | "other" = "nova"
): void {
    // Ship path
    if (obj instanceof Ship) {
        const ship = obj;
        const from = { v: ship.position.v, h: ship.position.h };
        const wasDockPlanet = ship.docked ? ship.dockPlanet : null;

        // Move ship
        ship.position.v = newV;
        ship.position.h = newH;
        ship.condition = "RED";

        // If docked, nova/blackhole knocks it loose → emit ship_undocked(reason)
        if (ship.docked) {
            ship.docked = false;
            ship.dockPlanet = null;

            // attribute event/message to the current owner of this ship, if any
            const owner = players.find((p) => p.ship === ship);
            if (owner && wasDockPlanet) {
                emitShipUndocked(owner, wasDockPlanet, reason);
                const where = wasDockPlanet.isBase
                    ? `${wasDockPlanet.side} base ${wasDockPlanet.name}`
                    : `planet ${wasDockPlanet.name}`;
                sendMessageToClient(owner, `Shock dislodged you from ${where}.`);
            }
        }

        // Broadcast generic displacement for the ship
        emitObjectDisplaced("ship", ship.name, from, { v: newV, h: newH }, reason);
        return;
    }

    // Planet path
    const planet = obj as Planet;
    const from = { v: planet.position.v, h: planet.position.h };

    planet.position.v = newV;
    planet.position.h = newH;

    // Keep bases array in sync if this planet is a base
    if (planet.isBase) {
        const arr = planet.side === "FEDERATION" ? bases.federation : bases.empire;
        const idx = arr.findIndex((b) => b === planet);
        if (idx !== -1) {
            arr[idx].position.v = newV;
            arr[idx].position.h = newH;
        }
    }

    // Broadcast generic displacement for the planet
    emitObjectDisplaced("planet", planet.name, from, { v: newV, h: newH }, reason);
}


export function triggerNovaAt(player: Player, v: number, h: number): void {
    if (!player.ship) return;

    emitNovaTriggered({ v, h }, player);
    communicateNova(player, v, h);

    const directions = [
        { disV: -1, disH: 0 }, // Up
        { disV: 1, disH: 0 },  // Down
        { disV: 0, disH: -1 }, // Left
        { disV: 0, disH: 1 },  // Right
    ];

    // Handle ships
    for (const other of players) {
        if (!other.ship) continue;

        if (isAdjacent(other.ship.position, { v, h })) {
            const damage = 1000 + ran() * 2000;
            applyNovaDamageShip(player, other, damage, v, h);

            // Find tractoring player (if any)
            const tractoringShip = other.ship.tractorPartner

            // Attempt displacement (Fortran: JUMP)
            const oldV = other.ship.position.v;
            const oldH = other.ship.position.h;

            for (const { disV, disH } of directions) {
                const newV = oldV + disV;
                const newH = oldH + disH;

                if (!isInGalaxy(newV, newH)) continue;
                if (!isAdjacent({ v: oldV, h: oldH }, { v: newV, h: newH })) continue;

                const posType = getPositionType(newV, newH);
                if (posType === "BLACK_HOLE") {
                    destroyShipByNova(other, newV, newH);
                    sendMessageToClient(other, `Your ship was displaced into a black hole at ${newV}-${newH} by a nova!`);
                    if (player !== other && player.ship) {
                        pointsManager.addEnemiesDestroyed(1, player, player.ship.side);
                    }
                    if (tractoringShip) {
                        disconnectTractorWithReason(tractoringShip, `Target destroyed by black hole at ${newV}-${newH}`);
                    }
                    break;
                } else if (posType === "EMPTY") {
                    displaceObject(other.ship, newV, newH);
                    sendMessageToClient(other, `Your ship was displaced to ${newV}-${newH} by a nova!`);
                    break;
                }
                //TODO and what if another ship or planet?
            }
            // Removed: if (!displaced) { disconnectTractorWithReason(other.ship, "nova"); }
        }
    }

    // Handle planets and bases
    for (const planet of planets) {
        if (isAdjacent(planet.position, { v, h })) {
            if (planet.isBase) {
                const side = planet.side;
                if (side !== "FEDERATION" && side !== "EMPIRE") continue;
                const basesArray = side === "FEDERATION" ? bases.federation : bases.empire;
                const base = basesArray.find(b => b.position.v === planet.position.v && b.position.h === planet.position.h);
                if (!base) continue;

                const oldV = base.position.v;
                const oldH = base.position.h;

                for (const { disV, disH } of directions) {
                    const newV = oldV + disV;
                    const newH = oldH + disH;

                    if (!isInGalaxy(newV, newH)) continue;
                    if (!isAdjacent({ v: oldV, h: oldH }, { v: newV, h: newH })) continue;

                    const posType = getPositionType(newV, newH);
                    if (posType === "BLACK_HOLE") {
                        base.energy = 0;
                        planet.isBase = false;
                        basesArray.splice(basesArray.indexOf(base), 1);
                        sendMessageToClient(player, `Base at ${oldV}-${oldH} was displaced into a black hole at ${newV}-${newH} by a nova!`);
                        if (player.ship.side !== side) {
                            pointsManager.addDamageToBases(10000, player, player.ship.side);
                        } else {
                            pointsManager.addDamageToBases(-10000, player, player.ship.side);
                        }
                        checkEndGame();
                        break;
                    } else if (posType === "EMPTY") {
                        displaceObject(base, newV, newH);
                        planet.position.v = newV;
                        planet.position.h = newH;
                        sendMessageToClient(player, `Base at ${oldV}-${oldH} was displaced to ${newV}-${newH} by a nova!`);
                        break;
                    }
                }
            }

            applyNovaDamagePlanet(player, planet, v, h);
        }
    }

    removeStarAt(v, h);
    pointsManager.addStarsDestroyed(1, player, player.ship.side);

    let time = 300;
    for (const star of stars.slice()) {
        if (isAdjacent(star.position, { v, h }) && ran() < 0.8) {
            setTimeout(() => {
                triggerNovaAt(player, star.position.v, star.position.h);
            }, time);
            time += 200;
        }
    }
}

function communicateNova(player: Player, v: number, h: number): void {
    if (!player.ship) return;
    const coords = ocdefCoords(player.settings.ocdef, player.ship.position, { v, h });

    const shooterMsg = player.settings.output === "SHORT"
        ? `NOVA @${coords}`
        : `A nova has detonated at ${coords}!`;
    sendMessageToClient(player, shooterMsg);

    sendMessageToOthersWithFormat(player, (recipient) => {
        const formatted = ocdefCoords("ABSOLUTE", recipient.ship?.position ?? { v: 0, h: 0 }, { v, h });
        return recipient.settings.output === "SHORT"
            ? `NOVA @${formatted}`
            : `A nova has detonated at ${formatted}!`;
    });
}

function applyNovaDamageShip(attacker: Player, player: Player, damage: number, v: number, h: number): void {
    if (!player.ship) return;
    player.ship.energy = Math.max(0, player.ship.energy - damage);
    player.ship.damage += damage / 2;
    player.ship.condition = "RED";

    const coords = ocdefCoords(player.settings.ocdef, player.ship.position, { v, h });
    const msg = player.settings.output === "SHORT"
        ? `HIT -${Math.round(damage)}`
        : `You were hit by a nova at ${coords} for ${Math.round(damage)} damage!`;
    sendMessageToClient(player, msg);

    if (player.ship.energy <= 0 || player.ship.damage >= 2500) {
        if (attacker !== player && attacker.ship) {
            pointsManager.addEnemiesDestroyed(1, attacker, attacker.ship.side);
        }
        destroyShipByNova(player, v, h);
    }
}

function applyNovaDamagePlanet(player: Player, planet: Planet, v: number, h: number): void {
    if (!player.ship) return;

    const coords = ocdefCoords(player.settings.ocdef, player.ship.position, { v, h });
    let msg: string;
    let destroyed = false;

    if (planet.isBase) {
        const side = planet.side;
        if (side !== "FEDERATION" && side !== "EMPIRE") return;
        const basesArray = side === "FEDERATION" ? bases.federation : bases.empire;
        const baseIndex = basesArray.findIndex(b => b.position.v === planet.position.v && b.position.h === planet.position.h);
        if (baseIndex === -1) return;

        const base = basesArray[baseIndex];
        const wasUndamaged = base.energy === 1000;
        const damage = 300 + (ran() * 200 - 100);
        base.energy = Math.max(0, base.energy - damage);

        const ihita = damage * 8 + ran() * 1000;
        if (player.ship.side !== side) {
            pointsManager.addDamageToBases(ihita, player, player.ship.side);
        } else {
            pointsManager.addDamageToBases(-ihita, player, player.ship.side);
        }

        if (wasUndamaged) {
            msg = player.settings.output === "SHORT"
                ? `BASE DST @${coords}`
                : `Base at ${coords} is under attack by a nova!`;
            sendMessageToClient(player, msg);
            sendMessageToOthersWithFormat(player, (recipient) => {
                const formatted = ocdefCoords("ABSOLUTE", recipient.ship?.position ?? { v: 0, h: 0 }, { v, h });
                return recipient.settings.output === "SHORT"
                    ? `BASE DST @${formatted}`
                    : `Base at ${formatted} is under attack by a nova!`;
            });
        }

        if (base.energy <= 0) {
            destroyed = true;
            planet.isBase = false;
            if (player.ship.side !== side) {
                pointsManager.addDamageToBases(10000, player, player.ship.side);
            } else {
                pointsManager.addDamageToBases(-10000, player, player.ship.side);
            }
            basesArray.splice(baseIndex, 1);
            checkEndGame();
        }

        msg = player.settings.output === "SHORT"
            ? destroyed ? `BASE X @${coords}` : `BASE HIT -${Math.round(damage)} @${coords}`
            : destroyed
                ? `Base at ${coords} was destroyed by a nova!`
                : `Base at ${coords} was hit by a nova for ${Math.round(damage)} damage!`;
        sendMessageToClient(player, msg);

        sendMessageToOthersWithFormat(player, (recipient) => {
            const formatted = ocdefCoords("ABSOLUTE", recipient.ship?.position ?? { v: 0, h: 0 }, { v, h });
            return recipient.settings.output === "SHORT"
                ? destroyed ? `BASE X @${formatted}` : `BASE HIT -${Math.round(damage)} @${formatted}`
                : destroyed
                    ? `Base at ${formatted} was destroyed by a nova!`
                    : `Base at ${formatted} was hit by a nova for ${Math.round(damage)} damage!`;
        });
    } else {
        planet.builds = Math.max(0, planet.builds - 3);

        if (planet.builds <= 0) {
            destroyed = true;
            pointsManager.addPlanetsDestroyed(1, player, player.ship.side);
            const planetIndex = planets.findIndex(p => p.position.v === v && p.position.h === h);
            if (planetIndex !== -1) {
                planets.splice(planetIndex, 1);
            }
            const basesArray = planet.side === "FEDERATION" ? bases.federation : bases.empire;
            const baseIndex = basesArray.findIndex(base => base.position.v === v && base.position.h === h);
            if (baseIndex !== -1) {
                basesArray.splice(baseIndex, 1);
            }
            planet.isBase = false;
            checkEndGame();
        }

        msg = player.settings.output === "SHORT"
            ? `PLNT HIT -3 @${coords}`
            : destroyed
                ? `Planet at ${coords} was destroyed by a nova!`
                : `Planet at ${coords} lost 3 builds due to a nova!`;
        sendMessageToClient(player, msg);

        sendMessageToOthersWithFormat(player, (recipient) => {
            const formatted = ocdefCoords("ABSOLUTE", recipient.ship?.position ?? { v: 0, h: 0 }, { v, h });
            return recipient.settings.output === "SHORT"
                ? `PLNT HIT -3 @${formatted}`
                : destroyed
                    ? `Planet at ${formatted} was destroyed by a nova!`
                    : `Planet at ${formatted} lost 3 builds due to a nova!`;
        });
    }
}

function destroyShipByNova(player: Player, v: number, h: number): void {
    if (!player.ship) return;

    sendMessageToClient(player, `Your ship was destroyed by a nova explosion!`);
    const name = player.ship.name ?? "Unknown";

    sendMessageToOthersWithFormat(player, (recipient) => {
        const coords = ocdefCoords("ABSOLUTE", recipient.ship?.position ?? { v: 0, h: 0 }, { v, h });
        return formatNovaKillMessage(name, coords, recipient.settings.output);
    });

    removePlayerFromGame(player);
}

function formatNovaKillMessage(name: string, coords: string, output: "SHORT" | "MEDIUM" | "LONG"): string {
    switch (output) {
        case "SHORT":
            return `${name[0]} > X @${coords}`;
        case "MEDIUM":
            return `${name} destroyed by nova @${coords}`;
        case "LONG":
        default:
            return `${name} was destroyed by a nova at ${coords}`;
    }
}

function removeStarAt(v: number, h: number): void {
    const index = stars.findIndex(star => star.position.v === v && star.position.h === h);
    if (index !== -1) {
        stars.splice(index, 1);
    }
}