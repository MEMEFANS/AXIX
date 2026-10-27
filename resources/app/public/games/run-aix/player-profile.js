// 本地免费冒险进度。与旧概率试玩账本隔离，不读取或更改 AIX 资产。
export const PROFILE_STORAGE_KEY = 'run-aix:player-profile:v1';
export const PROFILE_VERSION = 1;

export const LEVEL_IDS = Object.freeze(['level-1']);
export const SKINS = Object.freeze([
  Object.freeze({ id: 'aurora', name: '极光', starsRequired: 0 }),
  Object.freeze({ id: 'nebula', name: '星云', starsRequired: 2 }),
  Object.freeze({ id: 'sunrise', name: '晨曦', starsRequired: 3 }),
]);
export const ACHIEVEMENTS = Object.freeze([
  Object.freeze({ id: 'first-run', name: '启程', description: '完成第一次冒险记录' }),
  Object.freeze({ id: 'first-clear', name: '初次通关', description: '首次完成一关' }),
  Object.freeze({ id: 'star-collector', name: '拾星者', description: '累计获得 2 颗星' }),
  Object.freeze({ id: 'star-master', name: '星际收藏家', description: '累计获得 3 颗星' }),
  Object.freeze({ id: 'crystal-collector', name: '晶石收藏家', description: '累计收集 50 个星晶' }),
  Object.freeze({ id: 'untouched-clear', name: '完美航行', description: '无受击完成一关' }),
  Object.freeze({ id: 'combo-10', name: '闪避节奏', description: '连续闪避达到 10 次' }),
]);

const SETTING_DEFAULTS = Object.freeze({ sound: false, haptics: true, reducedMotion: false });
const LEVEL_ID_SET = new Set(LEVEL_IDS);
const SKIN_BY_ID = new Map(SKINS.map(skin => [skin.id, skin]));
const ACHIEVEMENT_BY_ID = new Map(ACHIEVEMENTS.map(achievement => [achievement.id, achievement]));
const MAX_SAFE_TOTAL = Number.MAX_SAFE_INTEGER;
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;
const copy = value => JSON.parse(JSON.stringify(value));
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const boundedInt = (value, fallback = 0, max = MAX_SAFE_TOTAL) =>
  Number.isSafeInteger(value) && value >= 0 && value <= max ? value : fallback;
const boundedNumber = (value, fallback = 0, max = 1_000_000) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : fallback;

function getBrowserStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function chinaDay(timestamp = Date.now()) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp + CHINA_OFFSET_MS);
  if (!Number.isFinite(date.getTime())) return null;
  const day = date.toISOString().slice(0, 10);
  return validDay(day) ? day : null;
}

function emptyData() {
  return {
    version: PROFILE_VERSION,
    settings: { ...SETTING_DEFAULTS },
    selectedSkin: SKINS[0].id,
    completed: {},
    daily: {},
    totalCrystals: 0,
    totalRuns: 0,
    totalDistance: 0,
    bestCombo: 0,
    achievements: [],
    runIds: [],
  };
}

function cleanLevelRecord(value) {
  if (!isRecord(value) || !Number.isSafeInteger(value.stars) || value.stars < 1 || value.stars > 3) return null;
  return {
    stars: boundedInt(value.stars, 0, 3),
    bestDistance: boundedNumber(value.bestDistance),
    bestTime: boundedNumber(value.bestTime, 0, 86_400),
    crystals: boundedInt(value.crystals),
    bestCombo: boundedInt(value.bestCombo),
  };
}

function emptyBestRecord() {
  return { stars: 0, bestDistance: 0, bestTime: 0, crystals: 0, bestCombo: 0 };
}

function cleanDailyRecord(value) {
  if (!isRecord(value) || typeof value.completed !== 'boolean') return null;
  const stars = boundedInt(value.stars, 0, 3);
  // A partial or corrupt record is still a valid attempt, but never a clear.
  const completed = value.completed && stars > 0;
  return {
    bestDistance: boundedNumber(value.bestDistance),
    bestTime: completed ? boundedNumber(value.bestTime, 0, 86_400) : 0,
    stars: completed ? stars : 0,
    crystals: boundedInt(value.crystals),
    completed,
  };
}

function cleanData(value) {
  const data = emptyData();
  if (!isRecord(value) || value.version !== PROFILE_VERSION) return data;

  if (isRecord(value.settings)) {
    for (const key of Object.keys(SETTING_DEFAULTS)) {
      if (typeof value.settings[key] === 'boolean') data.settings[key] = value.settings[key];
    }
  }
  if (typeof value.selectedSkin === 'string' && SKIN_BY_ID.has(value.selectedSkin)) data.selectedSkin = value.selectedSkin;
  if (isRecord(value.completed)) {
    for (const levelId of LEVEL_IDS) {
      const record = cleanLevelRecord(value.completed[levelId]);
      if (record) data.completed[levelId] = record;
    }
  }
  if (isRecord(value.daily)) {
    for (const [day, valueRecord] of Object.entries(value.daily)) {
      const record = validDay(day) && cleanDailyRecord(valueRecord);
      if (record) data.daily[day] = record;
    }
  }
  const stars = Object.values(data.completed).reduce((sum, record) => sum + record.stars, 0);
  if (stars < SKIN_BY_ID.get(data.selectedSkin).starsRequired) data.selectedSkin = SKINS[0].id;
  data.totalCrystals = boundedInt(value.totalCrystals);
  data.totalRuns = boundedInt(value.totalRuns);
  data.totalDistance = boundedNumber(value.totalDistance, 0, MAX_SAFE_TOTAL);
  data.bestCombo = Math.max(boundedInt(value.bestCombo), ...Object.values(data.completed).map(record => record.bestCombo));
  if (Array.isArray(value.achievements)) {
    data.achievements = [...new Set(value.achievements.filter(id => typeof id === 'string' && ACHIEVEMENT_BY_ID.has(id)))];
  }
  if (Array.isArray(value.runIds)) {
    data.runIds = [...new Set(value.runIds.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 160))];
  }
  return data;
}

function validRun(summary) {
  if (!isRecord(summary)) return { error: 'invalid-summary' };
  const runId = summary.runId ?? summary.id;
  if (typeof runId !== 'string' || runId.length < 1 || runId.length > 160 || runId.trim() !== runId) return { error: 'invalid-run-id' };
  if (typeof summary.levelId !== 'string' || summary.levelId.length > 40) return { error: 'invalid-level' };
  if (summary.levelId !== 'daily' && !LEVEL_ID_SET.has(summary.levelId)) return { error: 'invalid-level' };
  if (typeof summary.completed !== 'boolean') return { error: 'invalid-summary' };
  if (!Number.isFinite(summary.distance) || summary.distance < 0 || summary.distance > 1_000_000) return { error: 'invalid-summary' };
  if (!Number.isFinite(summary.elapsed) || summary.elapsed < 0 || summary.elapsed > 86_400) return { error: 'invalid-summary' };
  for (const key of ['hits', 'dodges', 'crystals', 'bestCombo']) {
    if (!Number.isSafeInteger(summary[key]) || summary[key] < 0 || summary[key] > 1_000_000) return { error: 'invalid-summary' };
  }
  if (!Number.isSafeInteger(summary.stars) || summary.stars < 0 || summary.stars > 3) return { error: 'invalid-summary' };
  if (!summary.completed && summary.stars !== 0) return { error: 'invalid-summary' };
  if (summary.completed && summary.stars === 0) return { error: 'invalid-summary' };
  const day = chinaDay(summary.date ?? Date.now());
  if (!day) return { error: 'invalid-summary' };
  return { runId, summary, day };
}

export class PlayerProfile {
  constructor(storage = getBrowserStorage()) {
    this.storage = storage;
    this.storageAvailable = false;
    this._data = this._read();
  }

  get data() { return copy(this._data); }
  get stars() {
    return Object.values(this._data.completed).reduce((sum, record) => sum + record.stars, 0);
  }
  get unlockedSkins() {
    const stars = this.stars;
    return SKINS.filter(skin => stars >= skin.starsRequired).map(skin => skin.id);
  }
  get achievements() {
    return this._data.achievements.map(id => ACHIEVEMENT_BY_ID.get(id)).filter(Boolean).map(copy);
  }

  _read() {
    try {
      const raw = this.storage?.getItem(PROFILE_STORAGE_KEY);
      this.storageAvailable = Boolean(this.storage && typeof this.storage.setItem === 'function');
      if (raw == null) return emptyData();
      return cleanData(JSON.parse(raw));
    } catch {
      return emptyData();
    }
  }

  _save() {
    try {
      if (!this.storage || typeof this.storage.setItem !== 'function') throw new Error('storage unavailable');
      this.storage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(this._data));
      this.storageAvailable = true;
      return true;
    } catch {
      // Keep the session playable when storage is disabled or quota is exhausted.
      this.storageAvailable = false;
      return false;
    }
  }

  _unlockAchievements() {
    const completed = Object.values(this._data.completed);
    const stars = this.stars;
    const unlocked = new Set(this._data.achievements);
    if (this._data.totalRuns >= 1) unlocked.add('first-run');
    if (completed.length) unlocked.add('first-clear');
    if (stars >= 2) unlocked.add('star-collector');
    if (stars >= 3) unlocked.add('star-master');
    if (this._data.totalCrystals >= 50) unlocked.add('crystal-collector');
    if (this._data.bestCombo >= 10) unlocked.add('combo-10');
    // A zero-hit clear is tracked explicitly as a run milestone, because a later retry may take damage.
    if (this._perfectClearRecorded) unlocked.add('untouched-clear');
    this._data.achievements = [...unlocked].filter(id => ACHIEVEMENT_BY_ID.has(id));
  }

  recordRun(summary) {
    const checked = validRun(summary);
    if (checked.error) return { ok: false, error: checked.error };
    if (this._data.runIds.includes(checked.runId)) return { ok: false, error: 'duplicate-run-id' };

    const { runId, summary: run } = checked;
    if (LEVEL_ID_SET.has(run.levelId) && !this.isUnlocked(run.levelId)) return { ok: false, error: 'level-locked' };
    if (this._data.totalRuns >= MAX_SAFE_TOTAL || this._data.totalCrystals > MAX_SAFE_TOTAL - run.crystals ||
        this._data.totalDistance > MAX_SAFE_TOTAL - run.distance) {
      return { ok: false, error: 'progress-limit' };
    }
    this._data.runIds.push(runId);
    this._data.totalRuns++;
    this._data.totalCrystals += run.crystals;
    this._data.totalDistance += run.distance;
    this._data.bestCombo = Math.max(this._data.bestCombo, run.bestCombo);
    if (LEVEL_ID_SET.has(run.levelId) && run.completed) {
      const previous = this._data.completed[run.levelId];
      const old = previous || emptyBestRecord();
      this._data.completed[run.levelId] = {
        stars: Math.max(old.stars, run.stars),
        bestDistance: Math.max(old.bestDistance, run.distance),
        bestTime: previous ? Math.min(old.bestTime, run.elapsed) : run.elapsed,
        crystals: Math.max(old.crystals, run.crystals),
        bestCombo: Math.max(old.bestCombo, run.bestCombo),
      };
      if (run.hits === 0) this._perfectClearRecorded = true;
    }
    if (run.levelId === 'daily') {
      const old = this._data.daily[checked.day] || { bestDistance: 0, bestTime: 0, stars: 0, crystals: 0, completed: false };
      this._data.daily[checked.day] = {
        bestDistance: Math.max(old.bestDistance, run.distance),
        bestTime: run.completed ? (old.completed ? Math.min(old.bestTime, run.elapsed) : run.elapsed) : old.bestTime,
        stars: Math.max(old.stars, run.stars),
        crystals: Math.max(old.crystals, run.crystals),
        completed: old.completed || run.completed,
      };
    }
    if (run.bestCombo >= 10 && !this._data.achievements.includes('combo-10')) this._data.achievements.push('combo-10');
    this._unlockAchievements();
    this._save();
    return { ok: true, duplicate: false, levelId: run.levelId, stars: this.stars };
  }

  setSetting(key, value) {
    if (!Object.hasOwn(SETTING_DEFAULTS, key) || typeof value !== 'boolean') return false;
    this._data.settings[key] = value;
    this._save();
    return true;
  }

  selectSkin(id) {
    const skin = SKIN_BY_ID.get(id);
    if (!skin || this.stars < skin.starsRequired) return false;
    this._data.selectedSkin = id;
    this._save();
    return true;
  }

  isUnlocked(levelId) {
    const index = LEVEL_IDS.indexOf(levelId);
    if (index < 0) return false;
    if (index === 0) return true;
    return Boolean(this._data.completed[LEVEL_IDS[index - 1]]);
  }

  bestScore(levelId) {
    if (!LEVEL_ID_SET.has(levelId)) return null;
    const record = this._data.completed[levelId];
    return record ? copy(record) : null;
  }

  bestDaily(day = chinaDay()) {
    if (!validDay(day)) return null;
    const record = this._data.daily[day];
    return record ? copy(record) : null;
  }

  resetProgress() {
    this._data = emptyData();
    this._perfectClearRecorded = false;
    this._save();
    return this.data;
  }
}
