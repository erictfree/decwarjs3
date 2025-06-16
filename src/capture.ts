import { Command } from "./command.js";
import { CAPTURE_DELAY_MIN_MS } from "./settings.js";
import {
    sendMessageToClient,
    putClientOnHold,
    releaseClient,
    sendOutputMessage,
    sendMessageToOthers,
} from "./communication.js";
import { getCoordsFromCommandArgs, ocdefCoords, chebyshev } from "./coords.js";
import { Player } from "./player.js";
import { planets, pointsManager, players, blackholes, stars } from "./game.js";
import { applyDamage } from "./phaser.js";

//  import { starbasePhaserDefense } from "./phaser.js"; //TODO: verify this isn't a real part of classic game

export function captureCommand(player: Player, command: Command, done?: () => void): void {
    if (command.args.length < 2) {
        sendMessageToClient(
            player,
            "Usage: CAPTURE [A|R] <vpos> <hpos> — must specify coordinates of target planet. Example: CAPTURE 10 25\r\n"
        );
        done?.();
        return;
    }

    if (player.ship === null) {
        sendMessageToClient(player, "You must be in a ship to use the capture command.\r\n");
        done?.();
        return;
    }

    const { position: { v: targetV, h: targetH }, mode, error } = getCoordsFromCommandArgs(
        player,
        command.args,
        player.ship.position.v,
        player.ship.position.h,
        false
    );

    if (error) {
        sendMessageToClient(player, `${error} for mode ${mode}\r\n`);
        done?.();
        return;
    }

    const planet = planets.find(p => p.position.h === targetH && p.position.v === targetV);
    if (!planet) {
        const shipAtTarget = players.some(p => p.ship && p.ship.position.h === targetH && p.ship.position.v === targetV);
        const blackHoleAtTarget = blackholes.some(bh => bh.position.h === targetH && bh.position.v === targetV);
        const starAtTarget = stars.some(star => star.position.h === targetH && star.position.v === targetV);

        if (shipAtTarget || blackHoleAtTarget || starAtTarget) {
            sendMessageToClient(player, "Capture THAT??  You have GOT to be kidding!!!\r\n");
            done?.();
            return;
        } else {
            sendMessageToClient(player, `No planet at those coordinates, Captain.\r\n`);
            done?.();
            return;
        }
    }

    if (planet.isBase && planet.side !== player.ship.side) {
        sendMessageToClient(player, `Captain, the enemy refuses our surrender ultimatum!\r\n`);
        done?.();
        return;
    }

    if (chebyshev(player.ship.position, { v: targetV, h: targetH }) > 1) {
        sendMessageToClient(player, `${player.ship.name} not adjacent to planet.\r\n`);
        done?.();
        return;
    }

    if (planet.side === player.ship.side) {
        const val = Math.random();
        if (val < 0.33) {
            sendMessageToClient(player, `Planet already captured, sir.\r\n`);
        } else if (val < 0.66) {
            sendMessageToClient(player, `But Captain, he's already on our side!\r\n`);
        } else {
            sendMessageToClient(player, `Captain, are you feeling well?\r\nWe are orbiting a FEDERATION planet!\r\n`);
        }
        done?.();
        return;
    }

    if (planet.captureLock.status) {
        sendMessageToClient(player, `The planet's government refuses to surrender.\r\n`);
        done?.();
        return;
    }

    // removed via Harris reported bug
    // if (player.ship.shieldsUp && player.ship.shieldEnergy > 0) {
    //     sendMessageToClient(player, "CAPTURE denied: shields must be lowered.");
    //     done?.();
    //     return;
    // }

    const hit = 50 + (planet.builds * 30);
    const captureDelayMs = planet.builds * 1000 + CAPTURE_DELAY_MIN_MS;

    if (planet.side !== "NEUTRAL" && planet.side !== player.ship.side) {
        const energyCost = planet.builds * 50;

        if (player.ship.energy < energyCost) {
            sendMessageToClient(player, `Insufficient energy: ${energyCost} required to CAPTURE this planet.\r\n`);
            done?.();
            return;
        }

        player.ship.energy -= energyCost;
    }

    const coords = ocdefCoords(player.settings.ocdef,
        player.ship!.position,
        { v: targetV, h: targetH });

    planet.captureLock = {
        status: true,
        time: Date.now(),
    };

    putClientOnHold(player, `${player.ship.name} capturing ${planet.side} planet ${coords}...`);

    const timer = setTimeout(() => {
        planet.captureLock.status = false;   // Reset capture lock status
        releaseClient(player);

        //const phaserDamage = 50 + (30 * buildLevel);
        // applyPhaserShipDamage(player, { x: planet.position.x, y: planet.position.y, side: planet.side }, phaserDamage);
        //TODO: add this back in

        if (!player.ship) {
            done?.();
            return;
        }
        const oldSide = planet.side;
        planet.builds = 0;
        planet.isBase = false;
        planet.side = player.ship.side;
        planet.captureLock.status = false;

        let othersMsg = `${player.ship!.name} has captured planet at ${coords}.`;
        if (planet.side === "NEUTRAL") {
            othersMsg = `${player.ship!.name} has captured a neutral planet at ${coords}.`;
        } else {
            othersMsg = `${player.ship!.name} has captured a planet at ${coords} from the ${oldSide}.`;
        }

        pointsManager.addPlanetsCaptured(1, player, player.ship!.side);

        sendMessageToOthers(player, othersMsg);
        sendOutputMessage(player, {
            SHORT: `captured.`,
            MEDIUM: `captured.`,
            LONG: `captured.`,
        });

        const damage = applyDamage(planet, player, hit, Math.random());
        if (damage) {
            sendMessageToClient(player, `Your ship has been damaged !`);
        }

        done?.();
    }, captureDelayMs);

    player.currentCommandTimer = timer;
}
