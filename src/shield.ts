import { Command } from "./command.js";
import { Player } from "./player.js";
import { sendMessageToClient } from "./communication.js";
import { matchesPattern } from "./util/util.js";
import { Ship } from "./ship.js";

export function shieldCommand(player: Player, command: Command): void {
    const action = command.args[0]?.toUpperCase();

    //if (!ensureDeviceOperational(player, "shield")) return;  TODO PUT BACK

    if (!action) {
        sendMessageToClient(player, "Usage: SHIELD [UP|DOWN|TRANSFER amount]");
        return;
    }

    if (matchesPattern(action, "Up")) {
        console.log("Raising shields");
        player.ship?.raiseShields();
    } else if (matchesPattern(action, "Down")) {
        console.log("Lowering shields");
        player.ship?.lowerShields();
    } else if (matchesPattern(action, "Transfer")) {
        const energyAmount = command.args[1];

        if (!energyAmount || !/^-?\d+$/.test(energyAmount)) {
            sendMessageToClient(player, "Bad energy amount.");
            return;
        }

        const amount = parseInt(energyAmount, 10);
        if (amount > 0) {
            player.ship?.transferToShields(amount);
        } else {
            player.ship?.transferFromShields(-amount);
        }
    } else {
        sendMessageToClient(player, "Unknown SHIELD command. Try UP, DOWN, or TRANSFER.");
    }
}
