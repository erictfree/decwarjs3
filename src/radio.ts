import { Command } from "./command.js";
import { Player } from "./player.js";
import { SHIPNAMES } from "./settings.js";
import { players } from "./game.js";
import { addPendingMessage, sendMessageToClient, } from "./communication.js";

export function radioCommand(player: Player, command: Command): void {
    const args = command.args;
    const action = args[0]?.toUpperCase();
    const rest = args.slice(1).join(" ").trim();

    if (!player.ship) {
        sendMessageToClient(player, "You must be in a ship to use RADIO.");
        return;
    }

    if (!player.ship.isDeviceOperational("radio")) return;

    switch (action) {
        case "ON":
            player.toggleRadio(true);
            return;
        case "OFF":
            player.toggleRadio(false);
            return;
        case "G":
        case "GAG":
            if (!args[1]) {
                sendMessageToClient(player, "Specify a ship to gag. Example: RADIO GAG LEXINGTON");
            } else {
                player.gagShip(args[1].toUpperCase());
            }
            return;
        case "U":
        case "UNGAG":
            if (!args[1]) {
                sendMessageToClient(player, "Specify a ship to ungag. Example: RADIO UNGAG LEXINGTON");
            } else {
                player.ungagShip(args[1].toUpperCase());
            }
            return;
        case undefined:
            sendMessageToClient(player, "No RADIO command specified. Use RADIO ON/OFF/GAG/UNGAG or RADIO <message>.");
            return;
    }
}