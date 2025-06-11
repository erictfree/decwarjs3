import { sendMessageToClient } from './communication.js';
import { Command } from './command.js';
import { Player } from './player.js';
import { Ship } from './ship.js';


export function damagesCommand(player: Player, command: Command): void {
    if (!player.ship) return;
    const devices = player.ship.devices;
    const args = command.args.map(a => a.toUpperCase());

    // Device mappings: token to full name and device key
    const deviceMappings: { [key: string]: { name: string; key: keyof Ship['devices']; minLength: number } } = {
        'WARP': { name: 'Warp', key: 'warp', minLength: 1 },
        'IMPULSE': { name: 'Impulse', key: 'impulse', minLength: 1 },
        'TORPEDO': { name: 'Torpedo', key: 'torpedo', minLength: 2 },
        'PHASER': { name: 'Phasers', key: 'phaser', minLength: 1 },
        'SHIELD': { name: 'Shields', key: 'shield', minLength: 1 },
        'COMPUTER': { name: 'Computer', key: 'computer', minLength: 1 },
        'RADIO': { name: 'Radio', key: 'radio', minLength: 1 },
        'TRACTOR': { name: 'Tractor', key: 'tractor', minLength: 2 },
        'LIFESUPPORT': { name: 'Life Sup', key: 'lifeSupport', minLength: 1 }
    };

    // Deduplicate args array to avoid duplicate device reports
    const seenArgs = new Set<string>();
    let args2 = args.filter(arg => {
        if (seenArgs.has(arg)) return false;
        seenArgs.add(arg);
        return true;
    });
    let showAll = false;
    let hasDamage = false;

    if (args2.length == 0) {
        args2 = ["W", "I", "TO", "P", "S", "C", "R", "TR", "L"];
    } else {
        showAll = true;
    }

    const output: string[] = [];
    for (const arg of args2) {
        const matchedDevice = Object.entries(deviceMappings).find(([fullToken, { minLength }]) =>
            arg.length >= minLength && fullToken.startsWith(arg)
        );
        if (matchedDevice) {
            const { name, key } = matchedDevice[1];
            const damage = devices[key as keyof typeof devices];
            //const damage = Math.random() * 300;  test
            if ((damage <= 0 && showAll) || damage > 0)
                output.push(`${name.padEnd(11)}${damage.toFixed(1).padStart(7)}`);
            if (damage > 0) hasDamage = true;
        }
    }
    if (!hasDamage) {
        sendMessageToClient(player, 'All systems operational.\r\n');
        return;
    } else {
        // Output header and aligned lines
        output.unshift('');
        output.unshift('Device       Damage');
        output.push('');
        output.forEach(line => sendMessageToClient(player, line));
    }
    return;


    // // General damage report
    // const reportLines: string[] = [];
    // for (const { name, key } of Object.values(deviceMappings)) {
    //     const damage = devices[key as keyof typeof devices];
    //     if (damage > 0) {
    //         reportLines.push(`${name.padEnd(16)}${damage.toFixed(0).padStart(6)}`);
    //     }
    // }
    // if (reportLines.length === 0) {
    //     sendMessageToClient(player, 'All systems operational.');
    // } else {
    //     sendMessageToClient(player, 'Damage Report:');
    //     sendMessageToClient(player, 'Device           Damage');
    //     reportLines.forEach(line => sendMessageToClient(player, line));
    // }
}