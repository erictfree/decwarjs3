import { ScanSetting, PromptSetting, ICDEF, OCDEF, OutputSetting } from './settings.js';
import { Player } from './player.js';
import { Command } from './command.js';
import { sendMessageToClient } from './communication.js';
//import { setPlayerSettings } from './db/userRecords.js';

// helper to match a user’s prefix against allowed options
function matchValue(input: string, options: readonly string[]): string | null {
    const upperInput = input.toUpperCase();
    const candidates = options.filter(opt => opt.startsWith(upperInput));
    return candidates.length === 1 ? candidates[0] : null;
}

export function setCommand(player: Player, command: Command): void {
    if (command.args.length < 2) {
        sendMessageToClient(player, "Usage: SET <setting> <value>");
        return;
    }

    // Allow unambiguous prefixes for setting names
    const settingArg = command.args[0];
    const selectedSetting = matchValue(settingArg, [
        "SCAN", "PROMPT", "OCDEF", "ICDEF", "NAME", "OUTPUT"
    ]);
    if (!selectedSetting) {
        sendMessageToClient(player, `Unknown setting: ${settingArg}`);
        return;
    }

    // Value argument
    const valueArg = command.args[1];
    const valueUpper = valueArg.toUpperCase();

    switch (selectedSetting) {
        case "SCAN": {
            const chosenScan = matchValue(valueUpper, ["LONG", "SHORT"]);
            if (chosenScan) {
                player.settings.scan = chosenScan as ScanSetting;
                sendMessageToClient(player, `SCAN set to ${chosenScan}.`);
            } else {
                sendMessageToClient(
                    player,
                    `Invalid SCAN value: ${valueArg}. Valid: Long, Short.`
                );
            }
            break;
        }

        case "PROMPT": {
            const chosenPrompt = matchValue(valueUpper, ["NORMAL", "INFORMATIVE"]);
            if (chosenPrompt) {
                player.settings.prompt = chosenPrompt as PromptSetting;
                sendMessageToClient(player, `PROMPT set to ${chosenPrompt}.`);
            } else {
                sendMessageToClient(
                    player,
                    `Invalid PROMPT value: ${valueArg}. Valid: Normal, Informative.`
                );
            }
            break;
        }

        case "OCDEF": {
            const chosenOC = matchValue(valueUpper, ["ABSOLUTE", "RELATIVE", "BOTH"]);
            if (chosenOC) {
                player.settings.ocdef = chosenOC as OCDEF;
                sendMessageToClient(
                    player,
                    `OCDEF set to ${chosenOC}.`
                );
            } else {
                sendMessageToClient(
                    player,
                    `Invalid OCDEF value: ${valueArg}. Valid: Absolute, Relative, Both).`
                );
            }
            break;
        }

        case "ICDEF": {
            const chosenIC = matchValue(valueUpper, ["ABSOLUTE", "RELATIVE"]);
            if (chosenIC) {
                player.settings.icdef = chosenIC as ICDEF;
                sendMessageToClient(
                    player,
                    `ICDEF set to ${chosenIC}.`
                );
            } else {
                sendMessageToClient(
                    player,
                    `Invalid ICDEF value: ${valueArg}. Valid: Absolute, Relative.`
                );
            }
            break;
        }

        case "NAME": {
            const newName = command.args.slice(1).join(" ");
            player.settings.name = newName;
            sendMessageToClient(
                player,
                `NAME set to ${newName}.`
            );
            break;
        }

        case "OUTPUT": {
            const chosenOutput = matchValue(valueUpper, ["LONG", "MEDIUM", "SHORT"]);
            if (chosenOutput) {
                player.settings.output = chosenOutput as OutputSetting;
                sendMessageToClient(player, `OUTPUT set to ${chosenOutput}.`);
            } else {
                sendMessageToClient(
                    player,
                    `Invalid OUTPUT value: ${valueArg}. Valid: Long, Medium, Short.`
                );
            }
            break;
        }

        default:
            // Shouldn't be reached
            sendMessageToClient(player, `Unknown setting: ${selectedSetting}`);
    }
    //setPlayerSettings(player); // TODO: implement
}
