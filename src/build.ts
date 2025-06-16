import { getCoordsFromCommandArgs, chebyshev, ocdefCoords } from "./coords.js";
import { planets } from "./game.js";
import { MAX_BUILDS_PER_PLANET, BUILD_DELAY_MIN_MS, BUILD_DELAY_RANGE, MAX_BASES_PER_TEAM } from "./settings.js";
import { putClientOnHold, releaseClient, sendOutputMessage, sendMessageToClient } from "./communication.js";
//import { starbasePhaserDefense } from "./base.js";
import { bases } from "./game.js";
import { Player } from "./player.js";
import { Command } from "./command.js";

export function buildCommand(player: Player, command: Command, done?: () => void): void {
    if (command.args.length < 2) {
        sendMessageToClient(player, "Usage: BUILD [A|R] <vpos> <hpos> — specify vertical and horizontal coordinates.");
        done?.();
        return;
    }
    if (!player.ship) {
        sendMessageToClient(player, "You must be in a ship to build.");
        done?.();
        return;
    }

    const { position: { v: targetV, h: targetH }, mode, error } =
        getCoordsFromCommandArgs(player, command.args, player.ship.position.v, player.ship.position.h, false);

    if (error) {
        sendMessageToClient(player, `${error} for mode ${mode}`);
        done?.();
        return;
    }

    if (chebyshev(player.ship.position, { v: targetV, h: targetH }) > 1) {
        sendMessageToClient(player, "BUILD failed: you must be adjacent (1 grid unit) to the target planet.");
        done?.();
        return;
    }

    const planet = planets.find(p => p.position.h === targetH && p.position.v === targetV);

    if (!planet) {
        const coords = ocdefCoords(player.settings.ocdef, player.ship.position, { v: targetV, h: targetH });
        sendMessageToClient(player, `No known planet at ${coords}. BUILD aborted.`);
        done?.();
        return;
    }

    if (planet.side === "NEUTRAL") {
        sendMessageToClient(player, "Planet not yet captured.");
        done?.();
        return;
    }

    if (planet.side !== player.ship.side) {
        sendMessageToClient(player, `BUILD denied: planet is held by the ${planet.side}.`);
        done?.();
        return;
    }

    if (planet.builds >= MAX_BUILDS_PER_PLANET) {
        sendMessageToClient(player, "BUILD limit reached: this planet is fully fortified.");
        done?.();
        return;
    }

    const delayMs = BUILD_DELAY_MIN_MS + Math.random() * BUILD_DELAY_RANGE;

    putClientOnHold(player, "Building...");
    const timer = setTimeout(() => {
        releaseClient(player);
        if (!player.ship) {
            sendMessageToClient(player, "You must be in a ship to build.");
            done?.();
            return;
        }

        planet.builds += 1;
        if (planet.builds === 5) {
            player.points.basesBuilt += 1;
        }
        if (planet.builds === MAX_BUILDS_PER_PLANET) {
            const teamBases = player.ship.side === "FEDERATION" ? bases.federation : bases.empire;
            if (teamBases.length >= MAX_BASES_PER_TEAM) {
                sendMessageToClient(player, `Maximum number of ${player.ship.side} starbases already active.`);
                done?.();
                return;
            }

            planet.makeBase(player.ship.side);

            const coords = ocdefCoords(player.settings.ocdef, player.ship.position, { v: targetV, h: targetH });

            sendOutputMessage(player, {
                SHORT: `Base created.`,
                MEDIUM: `Starbase built at ${coords}.`,
                LONG: `Planet at ${coords} has been promoted to a fully operational starbase.`,
            });
        }
        else {
            const coords = ocdefCoords(player.settings.ocdef, player.ship.position, { v: targetV, h: targetH });

            sendOutputMessage(player, {
                SHORT: `+1 build.`,
                MEDIUM: `Now ${planet.builds} build${planet.builds === 1 ? "" : "s"}.`,
                LONG: `One build added. Planet at ${coords} now has ${planet.builds} build${planet.builds === 1 ? "" : "s"}.`,
            });
        }
        done?.();
    }, delayMs);
    player.currentCommandTimer = timer;
    //starbasePhaserDefense(player); TODO: Add starbase phaser defense
}
