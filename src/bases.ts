import { listCommand } from "./list.js";
import { Player } from "./player.js";
import { Command } from "./command.js";

export function basesCommand(player: Player, command: Command): void {
    const newArgs = ["BASES", ...command.args];
    listCommand(player, { ...command, args: newArgs });
}
