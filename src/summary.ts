import { listCommandHelper } from "./list.js";
import { Command } from "./command.js";
import { Player } from './player.js';


export function summaryCommand(player: Player, command: Command): void {
    listCommandHelper(player, command, true);
}
