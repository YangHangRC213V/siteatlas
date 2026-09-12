import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { applyCachedAppearance } from './modules/settings/theme.ts';
import './styles/base.css';

// 先用本地缓存的主题/动效设置打底，避免深色用户看到白屏一闪（服务端设置随后校准）
applyCachedAppearance();

const container = document.getElementById('root');
if (container === null) throw new Error('缺少 #root 挂载点');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
