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
import { planets, pointsManager } from "./game.js";
//import { applyPhaserShipDamage } from "./base.js"; //TODO: add this back in

export function captureCommand(player: Player, command: Command, done?: () => void): void {
    if (command.args.length < 2) {
        sendMessageToClient(
            player,
            "Usage: CAPTURE [A|R] <vpos> <hpos> — must specify coordinates of target planet. Example: CAPTURE 10 25"
        );
        done?.();
        return;
    }

    if (player.ship === null) {
        sendMessageToClient(player, "You must be in a ship to use the capture command.");
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
        sendMessageToClient(player, `${error} for mode ${mode}`);
        done?.();
        return;
    }

    if (chebyshev(player.ship.position, { v: targetV, h: targetH }) > 1) {
        sendMessageToClient(player, "CAPTURE failed: you must be next to the planet.");
        done?.();
        return;
    }

    const planet = planets.find(p => p.position.h === targetH && p.position.v === targetV);
    if (!planet) {
        sendMessageToClient(player, `No known planet at ${targetV}-${targetH}. CAPTURE aborted.`);
        done?.();
        return;
    }

    if (planet.side === player.ship.side) {
        sendMessageToClient(player, `CAPTURE unnecessary: planet already belongs to your side.`);
        done?.();
        return;
    }

    if (player.ship.shieldsUp && player.ship.level > 0) {
        sendMessageToClient(player, "CAPTURE denied: shields must be lowered.");
        done?.();
        return;
    }

    const energyCost = planet.builds * 50;
    if (player.ship.energy < energyCost) {
        sendMessageToClient(player, `Insufficient energy: ${energyCost} required to CAPTURE this planet.`);
        done?.();
        return;
    }

    player.ship.energy -= energyCost;

    let captureDelayMs = planet.builds * 30 + CAPTURE_DELAY_MIN_MS;
    if (planet.side !== "NEUTRAL") {
        captureDelayMs += 500;
    }

    const coords = ocdefCoords(player.settings.ocdef,
        player.ship!.position,
        { v: targetV, h: targetH });

    putClientOnHold(player, `Capturing planet at ${coords}...`);

    const timer = setTimeout(() => {
        releaseClient(player);

        const buildLevel = planet.builds;
        //const phaserDamage = 50 + (30 * buildLevel);
        // applyPhaserShipDamage(player, { x: planet.position.x, y: planet.position.y, side: planet.side }, phaserDamage);
        //TODO: add this back in

        if (!player.ship) {
            done?.();
            return;
        }

        if (planet.builds > 0) {
            planet.builds -= 1;
            sendOutputMessage(player, {
                SHORT: `-1 build.`,
                MEDIUM: `Now ${planet.builds} build${planet.builds !== 1 ? "s" : ""}.`,
                LONG: `One build removed. Planet now has ${planet.builds} build${planet.builds !== 1 ? "s" : ""}.`,
            });
        }

        if (planet.builds === 0) {
            let othersMsg = `${player.ship!.name} has captured planet at ${coords}.`;
            if (planet.side === "NEUTRAL") {
                othersMsg = `${player.ship!.name} has captured a neutral planet at ${coords}.`;
            } else {
                othersMsg = `${player.ship!.name} has captured a planet at ${coords} from the ${planet.side}.`;
            }

            planet.side = player.ship!.side;
            pointsManager.addPlanetsCaptured(1, player, player.ship!.side);

            sendMessageToOthers(player, othersMsg);
            sendOutputMessage(player, {
                SHORT: `Planet captured.`,
                MEDIUM: `You captured planet at ${coords}.`,
                LONG: `You captured planet at ${coords}.`,
            });
        }

        done?.();
    }, captureDelayMs);

    player.currentCommandTimer = timer;
}
