import { sendMessageToClient } from "./communication.js";
import { Command } from "./command.js";
import { Player } from "./player.js";
import fs from 'fs';
import path from 'path';

let helpData = loadHelpData();
let helpCommands = getHelpCommands();
let pgCommands = ['CTl-c', 'INTRO', 'HInts', 'INput', 'Output', 'PAuses', 'PRegame'];

export function helpCommand(player: Player, command: Command): void {

    const arg = command.args[0]?.toUpperCase();

    if (!player.ship) {
        sendMessageToClient(player, "You must be in a ship to use HELP.");
        return;
    }

    if (!player.ship.isDeviceOperational("radio")) return;


    const condition = player.ship.computeCondition();
    if (condition === 'RED') {
        sendMessageToClient(player, 'You cannot get HELP while under RED alert!');
        return;
    }

    if (!arg) {
        sendMessageToClient(player, `For a list of commands type HELP *`);
        sendMessageToClient(player, `For help on a particular command type HELP command\r\n`);
        sendMessageToClient(player, `Besides commands, help is also available for:\r\n`);
        sendMessageToClient(player, `CTL-C     INTRO     HInts     INput     Output    PAuses`);
        sendMessageToClient(player, `PRegame\r\n`);
        sendMessageToClient(player, `Upper case letters mark the shortest acceptable abbreviation.\r\n`);
    } else if (arg === '*') {
        const cmds = helpCommands;
        const lines: string[] = [];
        for (let i = 0; i < cmds.length; i += 7) {
            const row = cmds.slice(i, i + 7)
                .map(cmd => cmd.padEnd(10, ' '))
                .join('');
            lines.push(row.trimEnd());
        }

        sendMessageToClient(player, `Commands are:\r\n`);
        for (const line of lines) {
            sendMessageToClient(player, line);
        }
    } else {
        const cmd = findCommandForArg(arg, helpCommands);
        if (helpData[cmd]) {
            sendMessageToClient(player, helpData[cmd]);
        } else {
            const pgcmd = findCommandForArg(arg, pgCommands);
            console.log(">>" + pgcmd);
            if (helpData[pgcmd]) {
                sendMessageToClient(player, helpData[pgcmd]);
            } else {
                sendMessageToClient(player, `No help available for "${arg}".`);
            }
        }
    }
}

/**
 * Reads the DECWAR help file and splits it into a map from
 * COMMAND → its full help text.
 *
 * Commands are recognized by lines starting with ".COMMAND".
 */
export function loadHelpData(): Record<string, string> {
    const filePath = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'help/DECWAR.HLP');
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);

    const helpData: Record<string, string> = {};
    let currentCmd: string | null = null;
    let buffer: string[] = [];

    for (const line of lines) {
        const match = line.match(/^\.(\S+)\s*$/);
        if (match) {
            if (currentCmd) {
                helpData[currentCmd] = buffer.join('\n').trim();
            }
            currentCmd = match[1].toUpperCase();
            buffer = [];
        } else if (currentCmd) {
            buffer.push(line + '\r'); // Add CR for Telnet formatting
        }
    }

    if (currentCmd) {
        helpData[currentCmd] = buffer.join('\n').trim();
    }
    return helpData;
}
export function getHelpCommands(): string[] {
    const filePath = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'help/DECWAR.HLP');
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);

    const commands: string[] = [];
    const syntaxRegex = /^Syntax:\s+([A-Za-z]+)(?:\s|$)/;

    for (const line of lines) {
        const match = line.match(syntaxRegex);
        if (match) {
            const cmd = match[1];
            if (!commands.includes(cmd)) {
                commands.push(cmd);
            }
        }
    }
    return commands;
}

function findCommandForArg(arg: string, commands: string[]): string {
    // Normalize the argument for matching
    const argUpper = arg.toUpperCase();

    for (const helpCommand of commands) {
        // The canonical command, e.g., "TRACTOR"
        const cmdUpper = helpCommand.toUpperCase();

        // Find the uppercase prefix (e.g., "TR" in "TRactor")
        const match = helpCommand.match(/^([A-Z]+)/);
        if (!match) continue;
        const prefix = match[1];
        const rest = helpCommand.slice(prefix.length);

        // The arg must start with the prefix
        if (!argUpper.startsWith(prefix)) continue;

        // Now, argUpper after the prefix must be a subset (in order) of the rest (case-insensitive)
        const argRest = argUpper.slice(prefix.length);
        let restIdx = 0;
        let matched = true;
        for (let i = 0; i < argRest.length; ++i) {
            const ch = argRest[i];
            // Find ch in rest, in order
            restIdx = rest.toUpperCase().indexOf(ch, restIdx);
            if (restIdx === -1) {
                matched = false;
                break;
            }
            restIdx += 1;
        }
        if (matched) {
            return cmdUpper;
        }
    }
    return "";
}