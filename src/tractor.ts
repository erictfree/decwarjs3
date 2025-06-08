// DECWAR-style TRACTOR (TR) command implementation
import { Player } from './player.js';
import { Command } from './command.js';
import { addPendingMessage, sendMessageToClient, sendOutputMessage } from './communication.js';
import { SHIPNAMES } from './settings.js';
import { Ship } from './ship.js';
import { chebyshev } from './coords.js';

export function tractorCommand(player: Player, command: Command): void {
    const args = command.args;
    const arg = args[0]?.toUpperCase();


    if (!player.ship) {
        sendMessageToClient(player, "You must be in a ship to use TRACTOR.");
        return;
    }

    if (!player.ship.isDeviceOperational("tractor")) return;

    // TRACTOR or TRACTOR OFF to release
    if (!arg || arg === "OFF") {
        if (player.ship.tractorPartner) {
            const target = player.ship.tractorPartner;
            target.tractorPartner = null;
            player.ship.tractorPartner = null;
            sendOutputMessage(player, {
                SHORT: "Trac. Beam off",
                MEDIUM: "Trac. Beam off",
                LONG: "Tractor beam broken, Captain."
            });
            addPendingMessage(target.player, `${player.ship.name} has disengaged tractor beam.`);
        } else {
            sendMessageToClient(player, "No tractor beam is active.");
        }
        return;
    }

    // Match by prefix
    const matches = SHIPNAMES.filter(name => name.startsWith(arg));
    if (matches.length === 0) {
        sendMessageToClient(player, `No ship found matching "${arg}".`);
        return;
    }
    if (matches.length > 1) {
        sendMessageToClient(player, `Ambiguous ship name "${arg}". Matches: ${matches.join(", ")}`);
        return;
    }

    const targetName = matches[0];
    const target = Ship.findPlayerByName(targetName);

    if (!target || !target.ship) {
        sendMessageToClient(player, `${targetName} is not active.`);
        return;
    }

    if (!target || !target.ship) {
        sendMessageToClient(player, `${targetName} is not active.`);
        return;
    }
    if (target === player) {
        sendMessageToClient(player, "You cannot tractor yourself.");
        return;
    }
    if (player.ship.side !== target.ship.side) {
        sendMessageToClient(player, "You may only tractor a ship from your own team.");
        return;
    }

    if (chebyshev(player.ship.position, target.ship.position) > 1) {
        sendMessageToClient(player, "Target ship is not adjacent.");
        return;
    }

    if (player.ship.tractorPartner) {
        sendMessageToClient(player, `Tractor beam activated, Captain.\r\nUse TRACTOR OFF to release.`);
        return;
    }

    if (player.ship.shieldsUp || target.ship.shieldsUp) {
        sendMessageToClient(player, "Both ships must have shields down to initiate tractor beam.");
        return;
    }

    // Establish link 
    player.ship.tractorPartner = target.ship;
    target.ship.tractorPartner = player.ship;

    sendMessageToClient(player, `Tractor beam locked on to ${target.ship.name}.`);
    sendOutputMessage(player, {
        SHORT: "Trac. Beam on",
        MEDIUM: "Trac. Beam on",
        LONG: "Tractor beam activated, Captain."
    });
    addPendingMessage(target, `You are now being tractored by ${player.ship.name}.`);
}

export function disconnectTractor(ship: Ship): void {
    if (ship.tractorPartner) {
        if (ship.tractorPartner.tractorPartner) {
            addPendingMessage(ship.tractorPartner.player, `Tractor beam broken, ${ship.name} disconnected.`);
            ship.tractorPartner.tractorPartner = null;
        }
        ship.tractorPartner = null;
        sendMessageToClient(ship.player, `Tractor beam broken, Captain.`);
    }
}

export function disconnectTractorWithReason(ship: Ship, reason: string): void {
    if (ship.tractorPartner) {
        addPendingMessage(ship.player, `Tractor beam broken, disconnected by ${reason}.`);

        if (ship.tractorPartner.tractorPartner) {
            addPendingMessage(ship.tractorPartner.player, `Tractor beam broken, disconnected by ${reason}.`);
            ship.tractorPartner.tractorPartner = null;
        }
        ship.tractorPartner = null;
    }
}