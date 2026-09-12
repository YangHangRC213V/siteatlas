/**
 * RemoteBrowserView —— 把服务端 Chromium 的画面画进 <canvas>，并把交互折成 CDP 输入回传（dev-spec §6.5）
 *
 * 关键点：
 *   1. 画面是 JPEG base64 帧，直接 <img> 会闪烁 → 用 Image 预解码后 drawImage 到 canvas；
 *   2. 坐标换算：canvas 是等比缩放显示的，事件坐标（CSS 像素）要按
 *      `页面视口 / 显示尺寸` 反算成 CDP 坐标，否则点击会偏；
 *   3. 键盘：canvas 需要 tabindex 才能拿到键盘事件；char 与 keyDown 分开上行，中文输入法走
 *      `char` 事件（CDP 的 type='char'）；
 *   4. 滚轮：浏览器会把 wheel 折成连续事件并 preventDefault 掉页面滚动，避免画布外滚动。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useManualStore } from './store.ts';

export interface RemoteBrowserViewProps {
  /** 页面视口（来自会话） */
  viewport: { width: number; height: number };
  /** 是否可交互（暂停/结束后只读） */
  interactive: boolean;
  className?: string;
}

const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

function modifiersOf(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  let bits = 0;
  if (event.altKey) bits |= MODIFIER_BITS.alt;
  if (event.ctrlKey) bits |= MODIFIER_BITS.ctrl;
  if (event.metaKey) bits |= MODIFIER_BITS.meta;
  if (event.shiftKey) bits |= MODIFIER_BITS.shift;
  return bits;
}

/** 把浏览器 KeyboardEvent.key 折成 CDP 需要的 key/code/windowsVirtualKeyCode */
function keyPayloadOf(event: React.KeyboardEvent): {
  key: string;
  code: string;
  text?: string;
  windowsVirtualKeyCode: number;
  modifiersBitmask: number;
} {
  const key = event.key;
  const code = event.code;
  const printable = key.length === 1;
  const vk = printable ? key.toUpperCase().charCodeAt(0) : specialKeyCode(key);
  return {
    key,
    code,
    ...(printable ? { text: key } : {}),
    windowsVirtualKeyCode: vk,
    modifiersBitmask: modifiersOf(event),
  };
}

function specialKeyCode(key: string): number {
  switch (key) {
    case 'Enter':
      return 13;
    case 'Tab':
      return 9;
    case 'Backspace':
      return 8;
    case 'Escape':
      return 27;
    case 'ArrowLeft':
      return 37;
    case 'ArrowUp':
      return 38;
    case 'ArrowRight':
      return 39;
    case 'ArrowDown':
      return 40;
    case 'Delete':
      return 46;
    case 'Home':
      return 36;
    case 'End':
      return 35;
    default:
      return 0;
  }
}

export function RemoteBrowserView({ viewport, interactive, className }: RemoteBrowserViewProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [ready, setReady] = useState(false);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const send = useManualStore((s) => s.send);
  const setFrameSink = useManualStore((s) => s.setFrameSink);
  const frameCount = useManualStore((s) => s.frameCount);

  /** 订阅帧：只保留最新一帧（解码是异步的，用「连续解码循环」避免堆积） */
  const pendingFrameRef = useRef<{ data: string; at: number } | null>(null);
  const drawingRef = useRef(false);

  const drawLoop = useCallback(() => {
    if (drawingRef.current) return;
    const frame = pendingFrameRef.current;
    if (frame === null) return;
    pendingFrameRef.current = null;
    drawingRef.current = true;
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (canvas === null || context === null || context === undefined) {
      drawingRef.current = false;
      return;
    }
    const image = imageRef.current ?? new Image();
    imageRef.current = image;
    image.onload = () => {
      if (image.naturalWidth > 0 && (canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight)) {
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      setReady(true);
      setLastAt(frame.at);
      drawingRef.current = false;
      // 继续消费可能在解码期间到达的新帧
      if (pendingFrameRef.current !== null) drawLoop();
    };
    image.onerror = () => {
      drawingRef.current = false;
    };
    image.src = `data:image/jpeg;base64,${frame.data}`;
  }, []);

  useEffect(() => {
    setFrameSink((frame) => {
      pendingFrameRef.current = { data: frame.data, at: frame.at };
      drawLoop();
    });
    return () => setFrameSink(null);
  }, [setFrameSink, drawLoop]);

  /** CSS 像素坐标 → 页面视口坐标 */
  const toPageCoords = useCallback(
    (event: { clientX: number; clientY: number }): { x: number; y: number } => {
      const canvas = canvasRef.current;
      if (canvas === null) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
      const scaleX = viewport.width / rect.width;
      const scaleY = viewport.height / rect.height;
      return { x: Math.round((event.clientX - rect.left) * scaleX), y: Math.round((event.clientY - rect.top) * scaleY) };
    },
    [viewport.height, viewport.width],
  );

  const mouseOf = (type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel', event: React.MouseEvent, extra?: { deltaY?: number }): void => {
    if (!interactive) return;
    const { x, y } = toPageCoords(event);
    const button: 'left' | 'right' | 'middle' | 'none' =
      event.button === 2 ? 'right' : event.button === 1 ? 'middle' : type === 'mouseMoved' ? 'none' : 'left';
    send({
      type: 'mouse',
      mouse: {
        type,
        x,
        y,
        button,
        clickCount: type === 'mouseMoved' ? 0 : 1,
        modifiersBitmask: modifiersOf(event),
        ...(extra?.deltaY !== undefined ? { deltaY: extra.deltaY } : {}),
      },
    });
  };

  const onMouseDown = (event: React.MouseEvent): void => {
    // 让 canvas 拿到键盘焦点，否则后续键盘事件收不到
    canvasRef.current?.focus();
    mouseOf('mousePressed', event);
  };
  const onMouseUp = (event: React.MouseEvent): void => mouseOf('mouseReleased', event);
  const onMouseMove = (event: React.MouseEvent): void => mouseOf('mouseMoved', event);

  const onWheel = (event: React.WheelEvent): void => {
    if (!interactive) return;
    event.preventDefault();
    mouseOf('mouseWheel', event, { deltaY: event.deltaY });
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (!interactive) return;
    const payload = keyPayloadOf(event);
    // 阻止空格/方向键滚动页面，保证事件都送到远端
    event.preventDefault();
    send({ type: 'key', key: { type: 'keyDown', ...payload } });
    // 可打印字符补一个 char 事件（CDP 的 keyDown 带 text 也能输入，但 IME 场景更依赖 char）
    if (payload.text !== undefined && !event.ctrlKey && !event.metaKey) {
      send({ type: 'key', key: { type: 'char', key: payload.key, text: payload.text, modifiersBitmask: payload.modifiersBitmask } });
    }
    if (payload.key === 'Enter' || payload.key === 'Backspace' || payload.key === 'Tab') {
      send({ type: 'key', key: { type: 'char', key: payload.key, text: payload.key === 'Enter' ? '\r' : '', modifiersBitmask: payload.modifiersBitmask } });
    }
  };

  const onKeyUp = (event: React.KeyboardEvent): void => {
    if (!interactive) return;
    event.preventDefault();
    send({ type: 'key', key: { type: 'keyUp', ...keyPayloadOf(event) } });
  };

  const onPaste = (event: React.ClipboardEvent): void => {
    if (!interactive) return;
    const text = event.clipboardData.getData('text');
    if (text.length === 0) return;
    event.preventDefault();
    for (const char of text) {
      send({ type: 'key', key: { type: 'char', key: char, text: char, modifiersBitmask: 0 } });
    }
  };

  return (
    <div className={`remote-view${className !== undefined ? ` ${className}` : ''}`}>
      <canvas
        ref={canvasRef}
        className="remote-view__canvas"
        tabIndex={0}
        aria-label="远端浏览器画面"
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseMove={onMouseMove}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onPaste={onPaste}
        onContextMenu={(e) => e.preventDefault()}
      />
      {!ready ? (
        <div className="remote-view__placeholder" aria-live="polite">
          <span className="skeleton" style={{ width: 240, height: 16, display: 'block', marginBottom: 8 }} />
          正在等待首帧画面…（浏览器启动通常需要 1–3 秒）
          {frameCount > 0 ? `（已收到 ${frameCount} 帧但尚未解码成功）` : ''}
        </div>
      ) : null}
      <div className="remote-view__hud">
        <span>
          视口 {viewport.width}×{viewport.height}
        </span>
        <span>·</span>
        <span>{frameCount} 帧</span>
        {lastAt !== null ? (
          <>
            <span>·</span>
            <span>最后 {new Date(lastAt).toLocaleTimeString('zh-CN')}</span>
          </>
        ) : null}
        {!interactive ? (
          <>
            <span>·</span>
            <span className="remote-view__readonly">只读（会话未在记录状态）</span>
          </>
        ) : null}
      </div>
    </div>
  );
}
