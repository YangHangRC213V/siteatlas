/**
 * 全屏 / 最大化（requirements §4.5「浏览器视图与树视图可切换或分屏」的延伸）
 *
 * 远端网页画面在小面板里不好操作（字小、点击目标小），所以给两层放大：
 *   1. **应用内最大化**：给根节点打 `data-remote-fullscreen`，CSS 把其它面板藏起来、画面铺满，
 *      树仍然在 DOM 里（只是不显示），退出即恢复滚动位置与展开态；
 *   2. **真全屏**：调用 Fullscreen API 让整个应用（或某一块）占满显示器，
 *      支持时用 F11 快捷键；不支持时（iframe / 权限拒绝）静默退化为最大化，不报错打断操作。
 *
 * 为什么不用「弹出新窗口」：画面来自 WebSocket + canvas，弹窗会另起一份 store 订阅，
 * 会话画面有两个订阅者时容易出现「一帧被消费两次」这类问题；全屏不改变组件树。
 */
import { useCallback, useEffect, useState } from 'react';

export interface FullscreenControls {
  /** 应用内最大化（视觉铺满） */
  maximized: boolean;
  /** 浏览器真全屏 */
  browserFullscreen: boolean;
  toggleMaximize(): void;
  toggleBrowserFullscreen(target?: HTMLElement | null): void;
  exit(): void;
}

/** 浏览器是否支持 Fullscreen API（在 iframe 里可能被权限拒绝，因此要能失败） */
function fullscreenSupported(): boolean {
  if (typeof document === 'undefined') return false;
  const element = document.documentElement as HTMLElement & { requestFullscreen?: () => Promise<void> };
  return typeof element.requestFullscreen === 'function';
}

export function useFullscreen(): FullscreenControls {
  const [maximized, setMaximized] = useState(false);
  const [browserFullscreen, setBrowserFullscreen] = useState(false);

  // 全屏状态交给浏览器事件驱动：用户按 Esc / F11 退出时界面要跟着变
  useEffect(() => {
    const onChange = (): void => setBrowserFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleMaximize = useCallback(() => setMaximized((value) => !value), []);

  const toggleBrowserFullscreen = useCallback((target?: HTMLElement | null) => {
    const element = (target ?? document.documentElement) as HTMLElement & { requestFullscreen?: () => Promise<void> };
    if (!fullscreenSupported()) {
      // 不支持就只做最大化，别弹错误打断用户
      setMaximized((value) => !value);
      return;
    }
    if (document.fullscreenElement !== null) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    void element.requestFullscreen?.().catch(() => {
      // 被浏览器拒绝（例如 iframe 缺 allowfullscreen）→ 退化为最大化
      setMaximized((value) => !value);
    });
  }, []);

  const exit = useCallback(() => {
    setMaximized(false);
    if (document.fullscreenElement !== null) void document.exitFullscreen().catch(() => undefined);
  }, []);

  return { maximized, browserFullscreen, toggleMaximize, toggleBrowserFullscreen, exit };
}

/**
 * 应用内最大化的连线：在 <html> 上打属性，CSS 据此隐藏其它面板。
 * 单独成函数（而不是写进 hook）是为了让 Escape 之类的键盘处理也能用同一套语义。
 */
export function applyMaximizedAttribute(maximized: boolean): void {
  const root = document.documentElement;
  if (maximized) root.setAttribute('data-remote-fullscreen', 'on');
  else root.removeAttribute('data-remote-fullscreen');
}
