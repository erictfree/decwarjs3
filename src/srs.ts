import { DEFAULT_SRS_RANGE } from "./settings.js";
import { Player } from './player.js';
import { Command } from './command.js';
import { scan } from "./scan.js";

export function shortRangeScanCommand(player: Player, command: Command): void {
    scan(player, command, DEFAULT_SRS_RANGE);
}