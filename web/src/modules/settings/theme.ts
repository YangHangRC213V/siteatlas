/**
 * 外观（主题 / 动效）—— requirements §5「深色模式可切换」「动效 ≤200ms 且可关」
 *
 * 两处持久化，各司其职：
 *   · **localStorage**：页面一加载（React 起来之前）就要用，避免深色用户看到白屏闪一下；
 *   · **settings 表**：这是「这个工具的设置」，换浏览器/重装前端后仍然生效。
 * 写入时两边都写；启动时以服务端值为准（服务端不可用时用本地缓存兜底）。
 */
const THEME_KEY = 'siteatlas.theme';
const MOTION_KEY = 'siteatlas.motion';

export type ThemeMode = 'system' | 'light' | 'dark';
export type MotionMode = 'on' | 'off';

export function applyTheme(mode: string): void {
  const theme: ThemeMode = mode === 'light' || mode === 'dark' ? mode : 'system';
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* 隐私模式下写不了 localStorage：不影响本次会话 */
  }
}

export function applyMotion(enabled: boolean): void {
  const root = document.documentElement;
  if (enabled) root.removeAttribute('data-motion');
  else root.setAttribute('data-motion', 'off');
  try {
    localStorage.setItem(MOTION_KEY, enabled ? 'on' : 'off');
  } catch {
    /* 同上 */
  }
}

/** 启动时的本地兜底：先用缓存值，拿到服务端设置后再校准 */
export function applyCachedAppearance(): void {
  try {
    const theme = localStorage.getItem(THEME_KEY);
    if (theme !== null) applyTheme(theme);
    const motion = localStorage.getItem(MOTION_KEY);
    if (motion !== null) applyMotion(motion !== 'off');
  } catch {
    /* 忽略 */
  }
}
