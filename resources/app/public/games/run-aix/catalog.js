import { HAZARDS } from './hazards.js?v=20261028c';

// 独立于收益/结局概率的本机障碍配置；每局开始读取一次并保存到对局快照。
export const CATALOG_STORAGE_KEY = 'run-aix:v3:catalog';
export const CATALOG_VERSION = 1;
const FIELDS = ['enabled', 'weight', 'minDistance', 'behavior', 'lanes', 'scenes', 'line'];
const BEHAVIORS = ['block', 'sweep', 'weather', 'slow'];
const plain = value => value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const freezeCatalog = catalog => Object.freeze(Object.fromEntries(Object.entries(catalog).map(([id, value]) => [id, Object.freeze({ ...value, lanes: Object.freeze([...value.lanes]), scenes: Object.freeze([...value.scenes]) })])));

export const DEFAULT_CATALOG = freezeCatalog(Object.fromEntries(HAZARDS.map(hazard => [hazard.id, {
  enabled: true, weight: 1, minDistance: hazard.minDistance || 0, behavior: hazard.behavior || 'block',
  lanes: [0, 1, 2], scenes: [0, 1, 2], line: hazard.line || '',
}])));

export function getDefaults() { return freezeCatalog(DEFAULT_CATALOG); }

export function validateCatalog(input = {}) {
  if (!plain(input)) throw new TypeError('障碍配置必须是按障碍 ID 索引的对象。');
  const errors = [], catalog = {};
  for (const id of Object.keys(input)) if (!Object.hasOwn(DEFAULT_CATALOG, id)) errors.push(`未知障碍：${id}`);
  for (const hazard of HAZARDS) {
    const supplied = input[hazard.id];
    if (Object.hasOwn(input, hazard.id) && !plain(supplied)) { errors.push(`${hazard.name}：配置必须是对象。`); continue; }
    for (const key of Object.keys(supplied || {})) if (!FIELDS.includes(key)) errors.push(`${hazard.name}：不支持的设置 ${key}`);
    const value = { ...DEFAULT_CATALOG[hazard.id], ...supplied };
    if (typeof value.enabled !== 'boolean') errors.push(`${hazard.name}：启用状态必须是开关值。`);
    if (typeof value.weight !== 'number' || !Number.isFinite(value.weight) || value.weight < 0 || value.weight > 100) errors.push(`${hazard.name}：相对权重须为 0–100。`);
    if (!Number.isInteger(value.minDistance) || value.minDistance < 0 || value.minDistance > 2000) errors.push(`${hazard.name}：最早出现距离须为 0–2000 的整数。`);
    if (!BEHAVIORS.includes(value.behavior)) errors.push(`${hazard.name}：请选择致命实体、横扫、天气或减速。`);
    for (const [key, label] of [['lanes', '车道'], ['scenes', '场景']]) {
      if (!Array.isArray(value[key]) || !value[key].length || value[key].some(item => ![0, 1, 2].includes(item)) || new Set(value[key]).size !== value[key].length) errors.push(`${hazard.name}：${label}须为 0、1、2 的非空子集，且不能重复。`);
      else value[key] = [...value[key]].sort((a,b) => a-b);
    }
    if (typeof value.line !== 'string' || value.line.length > 200) errors.push(`${hazard.name}：台词须为不超过 200 字符的文本。`);
    catalog[hazard.id] = value;
  }
  if (!errors.length) {
    const starters = Object.values(catalog).filter(value => value.enabled && value.weight > 0 && value.minDistance === 0);
    if (!starters.length) errors.push('至少保留一个已启用、权重大于 0、最早出现距离为 0 的障碍。');
    for (const scene of [0,1,2]) if (starters.length && !starters.some(value => value.scenes.includes(scene))) errors.push(`场景 ${scene + 1} 至少保留一个零米即可出现的有效障碍，避免空场景。`);
  }
  if (errors.length) { const error = new RangeError(errors.join('\n')); error.errors = errors; throw error; }
  return freezeCatalog(catalog);
}

function targetStorage(storage) { if (storage) return storage; try { return globalThis.localStorage; } catch { return null; } }
function readEnvelope(storage) {
  try {
    const value = JSON.parse(targetStorage(storage)?.getItem(CATALOG_STORAGE_KEY) || 'null');
    if (!value || value.version !== CATALOG_VERSION || !Number.isSafeInteger(value.revision) || value.revision < 1) return null;
    return { ...value, catalog: validateCatalog(value.catalog) };
  } catch { return null; }
}
export function loadCatalog(storage) { return readEnvelope(storage)?.catalog || DEFAULT_CATALOG; }
export function loadCatalogHistory(storage) {
  const current = readEnvelope(storage); if (!current) return [];
  return [...(Array.isArray(current.history) ? current.history : []), { revision:current.revision, updatedAt:current.updatedAt, action:current.action || 'save', catalog:current.catalog }].flatMap(entry => {
    try { if (!entry || !Number.isSafeInteger(entry.revision) || typeof entry.action !== 'string') return []; return [{...entry,catalog:validateCatalog(entry.catalog)}]; } catch { return []; }
  }).reverse();
}
function persist(input, storage, action) {
  const catalog = validateCatalog(input), target = targetStorage(storage);
  if (!target || typeof target.setItem !== 'function') throw new Error('浏览器不允许保存本机障碍配置，请启用网站存储后重试。');
  const old = readEnvelope(target);
  const history = old ? [...(Array.isArray(old.history) ? old.history : []), { revision:old.revision, updatedAt:old.updatedAt, action:old.action || 'save', catalog:old.catalog }].slice(-29) : [];
  const saved = { version:CATALOG_VERSION, revision:(old?.revision || 0)+1, updatedAt:new Date().toISOString(), action, catalog, history };
  try { target.setItem(CATALOG_STORAGE_KEY,JSON.stringify(saved)); } catch { throw new Error('本机障碍配置保存失败，可能是浏览器存储空间不足。'); }
  return saved;
}
export function saveCatalog(input,storage) { return persist(input,storage,'save'); }
export function resetCatalog(storage) { return persist(DEFAULT_CATALOG,storage,'reset'); }
export function rollbackCatalog(revision,storage) {
  const old=loadCatalogHistory(storage).find(entry=>entry.revision===Number(revision));
  if(!old)throw new Error('未找到这次障碍配置；本机仅保留最近 30 个版本。');
  return persist(old.catalog,storage,`rollback:${old.revision}`);
}
