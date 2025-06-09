import {
    sendMessageToClient,
    sendOutputMessage
} from "./communication.js";

import { GRID_WIDTH } from "./settings.js";
import { isInBounds, getCoordsFromCommandArgs } from "./coords.js";
import { Player } from "./player.js";
import { Command } from "./command.js";



export function oveCommand(player: Player, command: Command): void {

    if (!player.ship) {
        sendMessageToClient(player, "You must be in a ship to use this command.");
        return;
    }

    const args = command.args;
    const ship = player.ship;

    if (!player.ship.isDeviceOperational("warp")) {
        return;
    }

    if (!args.length) {
        sendMessageToClient(player, "Usage: MOVE/IMPULSE [A|R|C] <vpos> <hpos> OR MOVE C <ship>");
        return;
    }

    const { position: { v: targetVInput, h: targetHInput }, mode, error } = getCoordsFromCommandArgs(
        player,
        args,
        ship.position.v,
        ship.position.h,
        true
    );

    if (error) {
        sendOutputMessage(player, {
            SHORT: "MOVE > BAD COORD",
            MEDIUM: `Bad MOVE input (${mode})`,
            LONG: `Invalid MOVE command: ${error} in ${mode}`
        });
        return;
    }

    if (!isInBounds(targetVInput, targetHInput)) {
        sendOutputMessage(player, {
            SHORT: "MOVE > OUT OF BOUNDS",
            MEDIUM: "Invalid MOVE target sector.",
            LONG: `Target sector must be within 1–${GRID_WIDTH}.`
        });
        return;
    }

    player.ship.position = { v: targetVInput, h: targetHInput };
    sendMessageToClient(player, `OVER to sector ${targetVInput}-${targetHInput}`);
}
