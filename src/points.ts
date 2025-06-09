import { Command } from "./command.js";
import { sendMessageToClient } from "./communication.js";
import { matchesPattern } from "./util/util.js";
import { Player } from './player.js';
import { Side, settings } from './settings.js';
import { pointsManager } from './game.js';

export type PointCategory =
  | 'damageToEnemies'
  | 'enemiesDestroyed'
  | 'damageToBases'
  | 'planetsCaptured'
  | 'basesBuilt' // Used for both building and destroying bases
  | 'damageToRomulans'
  | 'starsDestroyed'
  | 'planetsDestroyed';

type Points = Record<PointCategory, number>;

interface Score {
  label: string;
  points: Points;
  ships?: number;
}

export class PointsManager {
  private sidePoints: Record<Side, Points>;
  private shipsCommissioned: Record<Side, number>;

  constructor() {
    const empty: Points = {
      damageToEnemies: 0,
      enemiesDestroyed: 0,
      damageToBases: 0,
      planetsCaptured: 0,
      basesBuilt: 0,
      damageToRomulans: 0,
      starsDestroyed: 0,
      planetsDestroyed: 0,
    };
    this.sidePoints = {
      FEDERATION: { ...empty },
      EMPIRE: { ...empty },
      ROMULAN: { ...empty },
      NEUTRAL: { ...empty }, // Unused but kept for consistency
    };
    this.shipsCommissioned = {
      FEDERATION: 0,
      EMPIRE: 0,
      ROMULAN: 0,
      NEUTRAL: 0,
    };
  }

  private add(category: PointCategory, amount: number, player: Player | undefined, side: Side): void {
    if (player) {
      player.points[category] += amount;
    }
    this.sidePoints[side][category] += amount;
  }

  addDamageToEnemies(amount: number, player: Player | undefined, side: Side): void {
    this.add('damageToEnemies', amount, player, side);
  }

  addEnemiesDestroyed(amount: number, player: Player | undefined, side: Side): void {
    this.add('enemiesDestroyed', amount, player, side);
  }

  addDamageToBases(amount: number, player: Player | undefined, side: Side): void {
    this.add('damageToBases', amount, player, side);
  }

  addPlanetsCaptured(amount: number, player: Player | undefined, side: Side): void {
    this.add('planetsCaptured', amount, player, side);
  }

  addBasesBuilt(amount: number, player: Player | undefined, side: Side): void {
    this.add('basesBuilt', amount, player, side); // Also used for base destruction
  }

  addDamageToRomulans(amount: number, player: Player | undefined, side: Side): void {
    this.add('damageToRomulans', amount, player, side);
  }

  addStarsDestroyed(amount: number, player: Player | undefined, side: Side): void {
    this.add('starsDestroyed', amount, player, side);
  }

  addPlanetsDestroyed(amount: number, player: Player | undefined, side: Side): void {
    this.add('planetsDestroyed', amount, player, side);
  }

  incrementShipsCommissioned(side: Side): void {
    this.shipsCommissioned[side]++;
  }

  getShipsCommissioned(side: Side): number {
    return this.shipsCommissioned[side];
  }

  getPointsForSide(side: Side): Points {
    return this.sidePoints[side];
  }
}

export function pointsCommand(player: Player, command: Command): void {
  if (player.ship === null) {
    sendMessageToClient(player, "You must be in a ship to use this command.");
    return;
  }

  const keywords = [];
  const filters = ["Me", "I", "Federation", "Human", "Empire", "Klingon", "Romulan", "All"];

  for (const arg of command.args) {
    let matched = false;
    for (const pattern of filters) {
      if (matchesPattern(arg, pattern)) {
        keywords.push(pattern.toUpperCase());
        matched = true;
        break;
      }
    }
    if (!matched) {
      sendMessageToClient(player, `Invalid filter: ${arg}`);
      return;
    }
  }

  const scores: Score[] = [];

  if (keywords.includes("ALL") || keywords.includes("ME") || keywords.includes("I")) {
    scores.push({
      label: player.ship.name,
      points: player.points,
      ships: 1, // Individual player has 1 ship
    });
  }

  if (keywords.includes("ALL") || keywords.includes("FEDERATION") || keywords.includes("HUMAN")) {
    scores.push({
      label: "FEDERATION",
      points: pointsManager.getPointsForSide("FEDERATION"),
      ships: pointsManager.getShipsCommissioned("FEDERATION"),
    });
  }

  if (keywords.includes("ALL") || keywords.includes("EMPIRE") || keywords.includes("KLINGON")) {
    scores.push({
      label: "EMPIRE",
      points: pointsManager.getPointsForSide("EMPIRE"),
      ships: pointsManager.getShipsCommissioned("EMPIRE"),
    });
  }

  if (keywords.includes("ALL") || keywords.includes("ROMULAN")) {
    scores.push({
      label: "ROMULAN",
      points: pointsManager.getPointsForSide("ROMULAN"),
      ships: pointsManager.getShipsCommissioned("ROMULAN"),
    });
  }

  const output = formatScores(scores);
  sendMessageToClient(player, output);
}

function formatScores(scores: Score[]): string {
  if (scores.length < 1 || scores.length > 4) {
    return "";
  }

  // Define scaling factors per DECWAR .POINTS help text
  const pointScales: Record<PointCategory, number> = {
    damageToEnemies: 1,    // Direct damage value
    enemiesDestroyed: 500, // 500 points per enemy
    damageToBases: 1,      // Direct damage value
    planetsCaptured: 100,  // 100 points per planet
    basesBuilt: 1000,      // 1000 points per base built or destroyed
    damageToRomulans: 1,   // Direct damage value
    starsDestroyed: -50,   // -50 points per star
    planetsDestroyed: -100 // -100 points per planet
  };

  // Define point-related headers
  const pointHeaders: { label: string; key: keyof Points }[] = [
    { label: "Damage to enemies", key: "damageToEnemies" },
    { label: "Enemies destroyed", key: "enemiesDestroyed" },
    { label: "Damage to bases", key: "damageToBases" },
    { label: "Planets captured", key: "planetsCaptured" },
    { label: "Bases built", key: "basesBuilt" }, // or "Bases destroyed"
    { label: "Damage to Romulans", key: "damageToRomulans" },
    { label: "Stars destroyed", key: "starsDestroyed" },
    { label: "Planets destroyed", key: "planetsDestroyed" },
  ];

  // Filter headers to only those with at least one non-zero value
  const activeHeaders = pointHeaders.filter(header =>
    scores.some(score => score.points[header.key] !== 0)
  );

  // Always include these headers
  const fixedHeaders = ["", "Total points:", "", "Number of ships:", "Pts. / player:", "Pts. / stardate:"];
  const headers = [...activeHeaders.map(h => h.label), ...fixedHeaders];
  const maxLabelLength = Math.max(...scores.map(s => s.label.length), ...headers.map(h => h.length));
  const colWidth = 15;
  const formatNum = (n: number | undefined): string => n !== undefined ? n.toString().padStart(6) : "0".padStart(6);

  // Build header row
  let result = " ".repeat(maxLabelLength);
  for (const score of scores) {
    result += score.label.padStart(colWidth);
  }
  result += "\r\n";

  // Build data rows
  for (const header of headers) {
    if (header === "") {
      result += "\r\n";
      continue;
    }
    result += header.padEnd(maxLabelLength);
    for (const score of scores) {
      let value: string;
      switch (header) {
        case "Total points:":
          value = formatNum(
            activeHeaders.reduce((sum, h) => sum + score.points[h.key] * pointScales[h.key], 0)
          );
          break;
        case "Number of ships:":
          value = formatNum(score.ships);
          break;
        case "Pts. / player:":
          value = formatNum(
            score.ships ? activeHeaders.reduce((sum, h) => sum + score.points[h.key] * pointScales[h.key], 0) / score.ships : 0
          );
          break;
        case "Pts. / stardate:":
          value = formatNum(
            settings.stardate ? activeHeaders.reduce((sum, h) => sum + score.points[h.key] * pointScales[h.key], 0) / settings.stardate : 0
          );
          break;
        default: {
          const pointHeader = activeHeaders.find(h => h.label === header);
          value = pointHeader ? formatNum(score.points[pointHeader.key] * pointScales[pointHeader.key]) : "0".padStart(6);
          break;
        }
      }
      result += value.padStart(colWidth);
    }
    result += "\r\n";
  }

  return `\r\n${result}\r\n`;
}
