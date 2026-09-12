/**
 * ULID 生成（Crockford Base32，26 字符）—— dev-spec §4 `sites.id TEXT PRIMARY KEY, -- ULID`
 *
 * 自实现而非引入依赖：node:sqlite 是内置模块，M0 不引入需要本地编译的原生模块，
 * 同时也不想为 40 行逻辑再加一个运行时依赖。
 * 单调性：同毫秒内递增随机位（单调 ULID），保证按 id 排序≈按创建时间排序，
 * 且对 10^5 量级站点/节点不会碰撞。
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford Base32，无 I L O U
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(now: number, len: number): string {
  if (!Number.isFinite(now) || now < 0) throw new RangeError(`ULID: 非法时间戳 ${now}`);
  let out = '';
  let t = Math.floor(now);
  for (let i = len - 1; i >= 0; i--) {
    out = ENCODING[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function randomChars(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += ENCODING[(bytes[i] as number) % 32];
  return out;
}

function incrementRandom(chars: string): string {
  const out = chars.split('');
  for (let i = out.length - 1; i >= 0; i--) {
    const idx = ENCODING.indexOf(out[i] as string);
    if (idx < 31) {
      out[i] = ENCODING[idx + 1] as string;
      return out.join('');
    }
    out[i] = '0';
  }
  throw new RangeError('ULID: 同毫秒随机位溢出');
}

let lastTime = -1;
let lastRandom = '';

/** 生成一个 ULID；同毫秒内多次调用严格递增 */
export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    lastRandom = incrementRandom(lastRandom);
  } else {
    lastTime = now;
    lastRandom = randomChars(RANDOM_LEN);
  }
  return encodeTime(now, TIME_LEN) + lastRandom;
}

/** 校验字符串是否为合法 ULID */
export function isUlid(value: string): boolean {
  if (value.length !== TIME_LEN + RANDOM_LEN) return false;
  for (const ch of value.toUpperCase()) {
    if (!ENCODING.includes(ch)) return false;
  }
  return true;
}

/** 从 ULID 还原时间戳（毫秒），非法输入返回 null */
export function ulidTime(value: string): number | null {
  if (value.length < TIME_LEN) return null;
  let t = 0;
  for (const ch of value.slice(0, TIME_LEN).toUpperCase()) {
    const idx = ENCODING.indexOf(ch);
    if (idx < 0) return null;
    t = t * 32 + idx;
  }
  return t;
}

/** 当前时间戳（秒）—— 与 dev-spec 中所有 `_at` INTEGER 列保持一致 */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
