import { sendMessageToClient } from "./communication.js";
import { Player } from "./player.js";
import { matchesPattern } from "./util/util.js";


/**
 * QUIT — Resign from the game. Destroys the ship and ends the session.
 */
export function quitCommand(player: Player): void {
    confirmQuit(player, 0);
}


function confirmQuit(player: Player, iter: number): void {
    if (iter > 4) {
        sendMessageToClient(player, "Too many attempts. Please try again later.");
        return;
    }
    player.currentPrompt = "Are you sure you want to quit? (Y/N): ";
    player.callBack = (pl, resp) => {
        const trimmed = resp.trim();
        if (matchesPattern(trimmed, "Yes")) {
            quit(pl);
        } else if (matchesPattern(trimmed, "No")) {
            sendMessageToClient(player, "", false, true);
        } else {
            //sendMessageToClient(pl, "Invalid response. Please enter Yes or No.");
            player.currentPrompt = "Are you sure you want to quit? (Y/N): ";
            sendMessageToClient(player, "", false, true);
            confirmQuit(pl, iter + 1);
        }
    };
}


function quit(player: Player): void {
    //  const score = player.score?.total ?? 0;
    const output = player.settings?.output ?? "MEDIUM";

    // Format message based on OutputSetting
    if (output === "SHORT") {
        sendMessageToClient(player, `Quit`, true, false);
    } else if (output === "LONG") {
        sendMessageToClient(player, "You have chosen to resign from your post as captain.", true, false);
    } else {
        // MEDIUM
        sendMessageToClient(player, "You have quit the game.", true, false);
    }

    // Remove player and disconnect
    player.quitGame();
}