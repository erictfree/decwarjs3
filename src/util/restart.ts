import { Player } from "../player.js";
import { sendMessageToClient } from "../communication.js";
//import { restartGame } from "../game.js";


export function restartCommand(player: Player) {
    if (!player.isAdmin) {
        sendMessageToClient(player, "Unknown command.");
    } else {
        sendMessageToClient(player, "Restarting the game...");
        //restartGame();
    }
}
