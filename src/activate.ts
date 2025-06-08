// ACTIVATE command for pre-game lobby
import { Player } from './player.js';
import { promptForShip, promptForLevel, promptForEmail } from './pregame.js';

/**
 * Handles the ACTIVATE <ship-name> command in pre-game mode.
 */
export function activateCommand(player: Player): void {
    if (!player.auth.authed) {
        promptForEmail(player, 0);
        //promptForLevel(player, 0);
    } else if (player.ship && player.ship.side === "NEUTRAL") {
        promptForLevel(player, 0);
    } else {
        promptForShip(player, 0);
    }
}
