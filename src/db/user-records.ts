import { ScanSetting, PromptSetting, OCDEF, ICDEF, OutputSetting } from "../settings.js";
import flatfilePkg from 'flat-file-db';
import { Player } from "../player.js";

const flatfile = (flatfilePkg as { default?: typeof flatfilePkg }).default || flatfilePkg;
const db = flatfile('playerSettings.db');

type Settings = {
    scan: ScanSetting;
    prompt: PromptSetting;
    ocdef: OCDEF;
    icdef: ICDEF;
    output: OutputSetting;
};

let dbOpen = false;


db.on('open', () => {
    dbOpen = true;
});


export function getPlayerSettings(player: Player): Settings | null {
    if (!dbOpen || !player.auth.email) {
        return null;
    }

    const settings = player.settings;//db.get(player.auth.email);
    if (settings) {
        //player.settings = settings;
        return player.settings;
    } else {
        return null;
    }
}

export function setPlayerSettings(player: Player): void {
    if (!dbOpen || !player.auth.email) {
        return;
    }

    db.put(player.auth.email, player.settings);
}
