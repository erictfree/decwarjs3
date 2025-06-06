import { listCommand } from "./list.js";
import { Player } from "./player.js";
import { Command } from "./command.js";

export function targetsCommand(player: Player, command: Command): void {
    const newArgs = ["ENEMY", ...command.args];
    const taggedCommand = { ...command, args: newArgs };

    // @ts-ignore: attach a custom flag to detect target mode
    //taggedCommand._suppressEnemyMarker = true;

    listCommand(player, taggedCommand);
}