import { sendMessageToClient, sendOutputMessage } from "./communication.js";
import { Player } from "./player.js";
import { Command } from "./command.js";
import { players } from "./game.js";
import { Ship } from "./ship.js";
import { chebyshev } from "./coords.js";
import { MAX_SHIP_ENERGY } from "./settings.js";

/**
 * ENERGY <shipName> <units>
 * Transfers energy to an adjacent allied ship, losing 10% in transit.
 */
export function energyCommand(player: Player, command: Command): void {
    const args = command.args;

    if (!player.ship) {
        sendMessageToClient(player, "You must be in a ship to use ENERGY.");
        return;
    }

    if (!player.ship.isDeviceOperational("radio")) return;

    if (args.length < 2) {
        sendMessageToClient(player, 'Usage: ENERGY <shipName> <amount>');
        return;
    }

    const targetInput = args[0].toUpperCase();
    const requested = parseInt(args[1], 10);
    if (isNaN(requested) || requested <= 0) {
        sendMessageToClient(player, 'Invalid energy amount.');
        return;
    }

    if (player.ship.energy < requested) {
        sendMessageToClient(player, 'Insufficient energy to transfer.');
        return;
    }

    // Match alive players with partial ship name match
    const name = Ship.resolveShipName(targetInput);
    if (!name) {
        sendMessageToClient(player, `No ship found matching "${targetInput}".`);
        return;
    }

    const matches = [...players].filter(p => p.ship && p.ship.name.toUpperCase() === name);

    if (matches.length === 0) {
        sendMessageToClient(player, `Ship "${targetInput}" not in service.`);
        return;
    } else if (matches.length > 1) {
        const names = matches.map(p => p.ship ? p.ship.name : "Unknown").join(', ');
        sendMessageToClient(player, `Ambiguous ship name "${targetInput}". Matches: ${names}`);
        return;
    }

    const target = matches[0];

    if (target.ship) {

        // Check adjacency
        if (chebyshev(player.ship.position, target.ship.position) > 1) {
            sendMessageToClient(player, `Target ${target.ship.name} is not adjacent.`);
            return;
        }

        // Energy transfer math
        const availableRoom = MAX_SHIP_ENERGY - target.ship.energy;
        if (availableRoom <= 0) {
            sendMessageToClient(player, `${target.ship.name} cannot accept more energy.`);
            return;
        }

        const sendAmount = Math.min(requested, availableRoom);
        player.ship.energy -= sendAmount;
        const received = Math.floor(sendAmount * 0.9);
        target.ship.energy += received;

        // Sender output
        sendOutputMessage(player, {
            SHORT: `ENERGY: ${sendAmount} → ${target.ship.name} (${received} recv)`,
            MEDIUM: `Transferred ${sendAmount} units to ${target.ship.name}; they received ${received} (10% lost).\nYour energy: ${player.ship.energy}\nTheir energy: ${target.ship.energy}`,
            LONG: `Energy transfer complete.\n${sendAmount} units sent to ${target.ship.name}.\n${target.ship.name} received ${received} units (10% lost in transmission).\nYour remaining energy: ${player.ship.energy}`
        });

        // Target output
        sendOutputMessage(target, {
            SHORT: `${received} ENERGY UNITS FROM ${player.ship.name}`,
            MEDIUM: `${received} units of energy received from ${player.ship.name}.`,
            LONG: `Incoming energy transfer from ${player.ship.name}.\nReceived ${received} units of energy.`
        });

    } {
        sendMessageToClient(player, `${name} ship not found.`);
        return;
    }
}
