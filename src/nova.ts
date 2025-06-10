import { sendMessageToClient, sendMessageToOthersWithFormat } from "./communication.js";
import { players, stars, pointsManager, removePlayerFromGame } from "./game.js";
import { Player } from "./player.js";
import { ocdefCoords } from "./coords.js";
import { disconnectTractorWithReason } from "./tractor.js";


export function triggerNovaAt(player: Player, v: number, h: number): void {
    if (!player.ship) return;

    communicateNova(player, v, h);

    for (const other of players) {
        if (!other.ship) continue;

        const dv = Math.abs(other.ship.position.v - v);
        const dh = Math.abs(other.ship.position.h - h);

        if (dh <= 1 && dv <= 1) {
            const damage = 1000 + Math.random() * 2000;
            applyNovaDamage(player, other, damage, v, h);
            disconnectTractorWithReason(player.ship, "nova");
        }
    }

    removeStarAt(v, h);
    pointsManager.addStarsDestroyed(1, player, player.ship.side);


    for (const star of stars.slice()) { //cascade nova
        const dh = Math.abs(star.position.h - h);
        const dv = Math.abs(star.position.v - v);
        if (dh <= 1 && dv <= 1) {
            triggerNovaAt(player, star.position.v, star.position.h);
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

function applyNovaDamage(attacker: Player, player: Player, damage: number, v: number, h: number): void {
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
