import { Player } from './player.js';
import { sendMessageToClient } from './communication.js';
import { Command } from './command.js';

export function tweakCommand(player: Player, command: Command): void {

    if (command.args[0] === "FEDERATION") {
        removeAllPlanetsAndBasesFromSide("FEDERATION");
    } else if (command.args[0] === "EMPIRE") {
        removeAllPlanetsAndBasesFromSide("EMPIRE");
    }
    sendMessageToClient(player, "Tweaked");
}



// // CODE TO TEST END OF GAME

// if (command.args[0] === "FEDERATION") {
//     removeAllPlanetsAndBasesFromSide("FEDERATION");
// } else if (command.args[0] === "EMPIRE") {
//     removeAllPlanetsAndBasesFromSide("EMPIRE");


// Removes all planets and all bases from a given side ("FEDERATION" or "EMPIRE")
import { Side } from './settings.js';
import { planets } from './game.js';
import { bases } from './game.js';

// Remove all planets and all bases belonging to the specified side
export function removeAllPlanetsAndBasesFromSide(side: Side): void {
    const sideKey = side === "FEDERATION" ? "federation" : side === "EMPIRE" ? "empire" : null;

    // bases.federation.length = 0;
    // bases.empire.length = 0;


    // Remove all planets on the specified side and all neutral planets
    for (let i = planets.length - 1; i >= 0; i--) {
        const planet = planets[i];
        if (planet.side === side || planet.side === "NEUTRAL") {
            planets.splice(i, 1);
        }
    }

    if (sideKey && bases[sideKey]) {
        bases[sideKey].length = 0;
    }

}
