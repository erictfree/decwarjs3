import { sendMessageToClient, sendMessageToOthersWithFormat } from "./communication.js";
import { players, stars, pointsManager, removePlayerFromGame, planets, bases, checkEndGame } from "./game.js";
import { Player } from "./player.js";
import { ocdefCoords, isAdjacent } from "./coords.js";
import { disconnectTractorWithReason } from "./tractor.js";
import { Planet } from "./planet.js";


export function triggerNovaAt(player: Player, v: number, h: number): void {
    if (!player.ship) return;

    communicateNova(player, v, h);

    for (const other of players) {
        if (!other.ship) continue;

        if (isAdjacent(other.ship.position, { v, h })) {
            const damage = 1000 + Math.random() * 2000;
            applyNovaDamageShip(player, other, damage, v, h);
            disconnectTractorWithReason(player.ship, "nova");
        }
    }

    for (const planet of planets) {
        if (isAdjacent(planet.position, { v, h })) {
            applyNovaDamagePlanet(player, planet, v, h);
        }
    }

    removeStarAt(v, h);
    pointsManager.addStarsDestroyed(1, player, player.ship.side);

    let time = 300;
    for (const star of stars.slice()) { //cascade nova, let's not stack resursive calls but do it event based 
        if (isAdjacent(star.position, { v, h }) && Math.random() < 0.8) {
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
        if (attacker !== player) {  // no credit for killing yourself
            if (attacker.ship) {
                pointsManager.addEnemiesDestroyed(1, attacker, attacker.ship.side);
            }
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
        if (side !== "FEDERATION" && side !== "EMPIRE") return; // Only valid base sides
        const basesArray = side === "FEDERATION" ? bases.federation : bases.empire;
        const baseIndex = basesArray.findIndex(b => b.position.v === v && b.position.h === h);
        if (baseIndex === -1) return; // Safety check

        const base = basesArray[baseIndex];

        // Base damage: reduce energy by 300 ± 100 (Fortran: max0(base(j,3,jbase) - 300 + iran(100), 0))
        const damage = 300 + (Math.random() * 200 - 100); // Random ±100
        const wasUndamaged = base.energy === 1000; // For distress call
        base.energy = Math.max(0, base.energy - damage);

        // Update planet.builds to reflect base energy (normalize, e.g., energy / 200)
        planet.builds = Math.max(0, Math.floor(base.energy / 200)); // Approximate mapping

        // Scoring: ±ihita (~damage * 8 + random(1000)) for damage, ±10000 for destruction
        const ihita = damage * 8 + Math.random() * 1000;
        if (player.ship.side !== side) {
            pointsManager.addDamageToBases(ihita, player, player.ship.side); // Enemy base damage
        } else {
            pointsManager.addDamageToBases(-ihita, player, player.ship.side); // Friendly base damage
        }

        // Distress call if base was undamaged (Fortran: iwhat = 9)
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

        // Check for destruction
        if (base.energy <= 0) {
            destroyed = true;
            planet.builds = 0;
            if (player.ship.side !== side) {
                pointsManager.addDamageToBases(10000, player, player.ship.side); // Enemy base destroyed
            } else {
                pointsManager.addDamageToBases(-10000, player, player.ship.side); // Friendly base destroyed
            }
            basesArray.splice(baseIndex, 1); // Remove from bases array
            // Assume baskil equivalent (undocking ships) handled elsewhere
            checkEndGame();
        }

        // Send hit/destruction message (Fortran: iwhat = 8 or 10)
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
        // Handle planet
        planet.builds = Math.max(0, planet.builds - 3); // Fortran: locpln(j,3) = locpln(j,3) - 3

        // Check for destruction
        if (planet.builds <= 0) {
            destroyed = true;
            pointsManager.addPlanetsDestroyed(1, player, player.ship.side); // -1000 points
            const planetIndex = planets.findIndex(p => p.position.v === v && p.position.h === h);
            if (planetIndex !== -1) {
                planets.splice(planetIndex, 1); // Remove from planets array
            }
            // Also remove from bases if there is a base at this planet's location
            const basesArray = planet.side === "FEDERATION" ? bases.federation : bases.empire;
            const baseIndex = basesArray.findIndex(base => base.position.v === v && base.position.h === h);
            if (baseIndex !== -1) {
                basesArray.splice(baseIndex, 1);
            }
            planet.isBase = false;
            checkEndGame();
        }

        // Send messages
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
        const coords = ocdefCoords("ABSOLUTE", recipient.ship?.position ?? { v: 0, h: 0 }, { v, h, });
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
