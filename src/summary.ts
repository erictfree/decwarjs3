import { listCommandHelper } from "./list.js";
import { Command } from "./command.js";
import { Player } from './player.js';


export function summaryCommand(player: Player, command: Command): void {
    // SUMMARY command should always show counts of ALL objects in the game
    // Create a modified command that includes SUMMARY mode
    const summaryCommand = new Command(
        command.key,
        [...command.args, "SUMMARY"], // Add SUMMARY mode to ensure it shows all objects
        command.raw
    );
    listCommandHelper(player, summaryCommand, true);
}
