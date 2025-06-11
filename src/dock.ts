import { Command } from "./command.js";
import { Player } from "./player.js";
import { putClientOnHold, sendMessageToClient, releaseClient } from "./communication.js";
import { planets } from "./game.js";
import { statusCommand } from "./status.js";
import { MAX_SHIP_ENERGY, MAX_SHIELD_ENERGY, MAX_TORPEDOES, DOCK_DELAY_MIN_MS, DOCK_DELAY_RANGE } from "./settings.js";
import { isAdjacent } from "./coords.js";

export function dockCommand(player: Player, command: Command, done?: () => void): void {
    if (!player.ship) {
        sendMessageToClient(player, "You must be in a ship to dock.");
        done?.();
        return;
    }

    if (player.ship.docked) {
        sendMessageToClient(player, "You are already docked.");
        done?.();
        return;
    }

    if (player.ship.shieldsUp && player.ship.shieldEnergy > 0) {
        sendMessageToClient(player, "Shields must be down to dock.");
        done?.();
        return;
    }

    let isBase = false;
    let nearPlanet = false;

    const side = player.ship.side;

    for (const planet of planets) {
        if (planet.side === side && isAdjacent(player.ship.position, planet.position)) {
            nearPlanet = true;
            if (planet.isBase) {
                isBase = true;
            }
            break;
        }
    }

    if (!nearPlanet) {
        sendMessageToClient(player, "No friendly base or captured planet nearby to dock.");
        done?.();
        return;
    }

    const showStatus = command.args.length > 0 && "STATUS".startsWith(command.args[0].toUpperCase());
    if (command.args.length > 0 && !showStatus) {
        sendMessageToClient(player, "Invalid command. Use 'STATUS' to show status.");
        done?.();
        return;
    }

    const statusArgs = showStatus ? command.args.slice(1).map(a => a.toUpperCase()) : [];

    const delayMs = DOCK_DELAY_MIN_MS + Math.random() * DOCK_DELAY_RANGE;
    putClientOnHold(player, "Docking...");

    const timer = setTimeout(() => {
        releaseClient(player);

        if (!player.ship) {
            sendMessageToClient(player, "You must be in a ship to dock.");
            done?.();
            return;
        }

        const ship = player.ship;
        const wasFullyRepaired =
            ship.energy >= MAX_SHIP_ENERGY &&
            ship.shieldEnergy >= MAX_SHIELD_ENERGY &&
            ship.torpedoes >= MAX_TORPEDOES &&
            ship.damage <= 0;

        // Dock status
        // Apply refills
        const wasAlreadyDocked = ship.docked;
        ship.docked = true;
        ship.condition = "GREEN";

        // Repair / refuel rates
        const energyGain = isBase ? 1000 : 500;
        const shieldGain = isBase ? 500 : 250;
        const torpGain = isBase ? 10 : 5;
        const damageRepair = isBase ? 100 : 50;
        const dockedBonus = isBase ? 200 : 100;

        ship.energy = Math.min(MAX_SHIP_ENERGY, ship.energy + energyGain);
        ship.shieldEnergy = Math.min(MAX_SHIELD_ENERGY, ship.shieldEnergy + shieldGain);
        ship.shieldsUp = false;
        ship.torpedoes = Math.min(MAX_TORPEDOES, ship.torpedoes + torpGain);
        ship.damage = Math.max(0, ship.damage - damageRepair - (wasAlreadyDocked ? dockedBonus : 0));
        ship.devices.lifeSupport = 0;

        // Messages
        if (wasFullyRepaired) {
            sendMessageToClient(player, "Docking has no effect. Ship fully supplied.");
        } else {
            sendMessageToClient(player, "Docking complete. Supplies replenished.");
        }

        sendMessageToClient(player, "Ship condition is now GREEN.");

        if (showStatus) {
            statusCommand(player, {
                ...command,
                args: statusArgs,
            });
        }
        //TODO STATUS
        done?.();
    }, delayMs);

    player.currentCommandTimer = timer;
    // starbasePhaserDefense(player); TODO: Add starbase phaser defense
}