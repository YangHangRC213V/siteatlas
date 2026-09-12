import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * web 构建产物输出到 web/dist，由 server 一条命令托管（dev-spec §2「单命令启动」）。
 * dev 模式：vite 代理 /api 到本地服务端，前端仍走 API，不直连数据库（§3 约束）。
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
});
