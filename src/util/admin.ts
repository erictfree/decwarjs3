import { Player } from "../player.js";
import { sendMessageToClient } from "../communication.js";
import { Command } from "../command.js";

export function promoteCommand(player: Player, command: Command) {
    if (command.args[0] === "theq") {
        player.isAdmin = true;
        sendMessageToClient(player, "You are now an admin.");
    } else {
        sendMessageToClient(player, "Unknown command");
    }
}