import { DEFAULT_RULES, multiplierForDistance, payoutForDistance } from './rules.js';
import { HAZARDS } from './hazards.js';
export const CONFIG = DEFAULT_RULES;
export const SCENES = [
  { name: '星空之城', top: '#111238', bottom: '#343179', accent: '#a59bff' },
  { name: '交易所大厅', top: '#091d32', bottom: '#125368', accent: '#55f4dc' },
  { name: '稳定币海域', top: '#092843', bottom: '#16788c', accent: '#6feaff' },
];
export const OBSTACLES = HAZARDS;
export const multiplier = multiplierForDistance;
export const payout = payoutForDistance;
