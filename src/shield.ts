import { Command } from "./command.js";
import { Player } from "./player.js";
import { sendMessageToClient } from "./communication.js";
import { matchesPattern } from "./util/util.js";
import { emitShieldsToggled } from "./api/events.js";

export function shieldCommand(player: Player, command: Command): void {
    const action = command.args[0]?.toUpperCase();

    if (!player.ship) {
        sendMessageToClient(player, "You must be in a ship to use SHIELD.");
        return;
    }

    if (!player.ship.isDeviceOperational("shield")) return;

    if (!action) {
        sendMessageToClient(player, "Usage: SHIELD [UP|DOWN|TRANSFER amount]");
        return;
    }


    if (matchesPattern(action, "Up")) {
        if (!player.ship) return;
        const wasUp = player.ship.shieldsUp;
        const before = player.ship.shieldEnergy;

        player.ship.raiseShields();

        if (!wasUp && player.ship.shieldsUp) {
            emitShieldsToggled(player, true, { before, after: player.ship.shieldEnergy });
        }
    } else if (matchesPattern(action, "Down")) {
        if (!player.ship) return;
        const wasUp = player.ship.shieldsUp;
        const before = player.ship.shieldEnergy;

        player.ship.lowerShields();

        if (wasUp && !player.ship.shieldsUp) {
            emitShieldsToggled(player, false, { before, after: player.ship.shieldEnergy });
        }
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

