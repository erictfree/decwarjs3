// ACTIVATE command for pre-game lobby
import { Player } from './player.js';
import { promptForShip, promptForLevel, promptForEmail, promptForRegularOrTournament } from './pregame.js';
import { settings } from './settings.js';

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
        if (settings.generated) {
            promptForShip(player, 0);
        } else {
            promptForRegularOrTournament(player, 0);
        }
    }
}
