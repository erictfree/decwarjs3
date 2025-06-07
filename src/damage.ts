import { sendMessageToClient } from './communication.js';
import { Command } from './command.js';
import { Player } from './player.js';

const devices: string[] = [
    "Shield",
    "Warp",
    "Impulse",
    "Life Support",
    "Torpedo",
    "Phaser",
    "Computer",
    "Radio"
];

type DeviceKey = 'warp' | 'impulse' | 'torpedo' | 'phaser' | 'shield' | 'computer' | 'radio' | 'tractor' | 'lifeSupport';

const deviceKeyMap: Record<string, DeviceKey> = {
    'SHIELD': 'shield',
    'WARP': 'warp',
    'IMPULSE': 'impulse',
    'LIFE SUPPORT': 'lifeSupport',
    'TORPEDO': 'torpedo',
    'PHASER': 'phaser',
    'COMPUTER': 'computer',
    'RADIO': 'radio'
};

/**
 * Matches prefixes (substrings starting from index 0) of device full names from an input array of strings
 * and returns full device names. For all devices (Shield, Warp, Impulse, Life Support, Torpedo, Phaser,
 * Computer, Radio), a single character is enough to match (e.g., "S" for Shield, "T" for Torpedo).
 * Matching is case-insensitive.
 *
 * @param args - Array of strings to match as prefixes of device full names.
 * @returns Array of full device names that match the input prefixes, with no duplicates.
 */
function matchDevices(args: string[]): string[] {
    const matchedDevices: string[] = [];

    for (const arg of args) {
        const upperArg = arg.toUpperCase(); // Case-insensitive matching
        for (const device of devices) {
            // Check if the input string is a prefix of the device name
            if (device.toUpperCase().startsWith(upperArg)) {
                // Add the full device name if not already included
                if (!matchedDevices.includes(device)) {
                    matchedDevices.push(device.toUpperCase());
                }
            }
        }
    }

    return matchedDevices;
}

/**
 * Syntax: DAMAGES [<device codes>]
 * Lists specified ship devices or all devices if no args.
 * Shows each device’s damage amount; marks inoperative at ≥300.
 */
export function damagesCommand(player: Player, command: Command): void {
    if (!player.ship) {
        sendMessageToClient(player, "You must be in a ship to use this command.");
        return;
    }

    const formatLabel = (label: string) =>
        label.charAt(0).toUpperCase() + label.slice(1).toLowerCase();


    const args = command.args.map(a => a.toUpperCase());
    const devices = matchDevices(args);


    if (devices.length === 0) {
        sendMessageToClient(player, 'No matching devices found.');
        return;
    }

    const outputSetting = player.settings?.output ?? "MEDIUM";

    if (outputSetting === "SHORT") {
        const summary = devices.map(key => {
            const deviceKey = deviceKeyMap[key];
            const dmg = player.ship!.devices[deviceKey];
            const flag = dmg >= 300 ? '*' : '';
            const label = formatLabel(key);
            return `${label}:${dmg}${flag}`;
        }).join('  ');

        sendMessageToClient(player, `DAMAGES: ${summary}`);
        return;
    }

    for (const key of devices) {
        const deviceKey = deviceKeyMap[key];
        const dmg = player.ship!.devices[deviceKey];
        const inop = dmg >= 300;

        if (outputSetting === "LONG") {
            const label = formatLabel(key);
            const paddedLabel = label.padEnd(22, '.');
            const state = inop ? 'INOPERATIVE' : 'OPERATIONAL';
            sendMessageToClient(player, `${paddedLabel} ${String(dmg).padStart(4)}     ${state}`);
        } else {
            // MEDIUM (default)
            const label = formatLabel(key);
            const padded = label.padEnd(18, ' ');
            sendMessageToClient(player, `${padded} ${dmg} damage`);
        }
    }
}
//All devices functional.