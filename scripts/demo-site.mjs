/**
 * 本地演示站点（M1 验收与截图用，不依赖外网）
 *
 * 结构：
 *   /                     首页（9 条站内链接 + 1 条外域）
 *   /about                关于（链接回首页/团队/文档/图片）
 *   /docs                 文档（含 4 种变体链接：尾斜杠、fragment、跟踪参数、真实 query）
 *   /docs/guide           指南 → /docs/guide/install
 *   /docs/api             API
 *   /team                 团队
 *   /spa                  纯 JS 渲染页（静态无链接，触发 Playwright 回落）
 *   /paged?page=n         自环分页（验证分页护栏）
 *   /assets/logo.png      素材（只登记不递归）
 *   /missing              404
 *   /blocked/secret       robots.txt 禁止
 *   /robots.txt           声明 Disallow: /blocked/
 *
 * 用法：node scripts/demo-site.mjs [port]
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 8899);
const origin = `http://127.0.0.1:${port}`;
const FILLER =
  '本页面用于 SiteAtlas 采集内核的端到端验收。正文需要足够长，以便正文指纹计算生效，从而验证内容去重不会误伤结构去重。';

const page = (title, body) =>
  `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title></head><body><main>${body}</main></body></html>`;

const routes = {
  '/robots.txt': { type: 'text/plain', body: `User-agent: *\nDisallow: /blocked/\nCrawl-delay: 0\n\nSitemap: ${origin}/sitemap.xml\n` },
  '/': {
    type: 'text/html',
    body: page(
      '本地演示站首页',
      `<h1>首页</h1><p>${FILLER}</p><nav>
        <a href="/about">关于我们</a>
        <a href="/docs">文档</a>
        <a href="/team">团队</a>
        <a href="/spa">SPA 页面</a>
        <a href="${origin}/paged?page=1">分页列表</a>
        <a href="/missing">不存在的页面</a>
        <a href="/blocked/secret">robots 禁止页</a>
        <a href="/assets/logo.png">Logo 图片</a>
        <a href="http://localhost:1/outside">外域链接</a>
      </nav>`,
    ),
  },
  '/about': {
    type: 'text/html',
    body: page('关于我们', `<h1>关于</h1><p>${FILLER}</p><p><a href="/">回首页</a></p><p><a href="/team">团队</a></p><p><a href="/docs">文档</a></p>`),
  },
  '/docs': {
    type: 'text/html',
    body: page(
      '文档',
      `<h1>文档</h1><p>${FILLER}</p><ul>
        <li><a href="/docs/guide">指南</a></li>
        <li><a href="/docs/api">API</a></li>
        <li><a href="/docs/guide#step-2">指南第二步（页内锚点）</a></li>
        <li><a href="/docs/guide?utm_source=newsletter&utm_medium=email">指南（带跟踪参数）</a></li>
        <li><a href="/docs/guide/">指南（尾斜杠变体）</a></li>
      </ul>`,
    ),
  },
  '/docs/guide': {
    type: 'text/html',
    body: page('指南', `<h1>指南</h1><p>${FILLER}</p><p><a href="/docs/guide/install">安装</a></p><p><a href="/docs">返回文档</a></p>`),
  },
  '/docs/guide/install': {
    type: 'text/html',
    body: page('安装', `<h1>安装</h1><p>${FILLER}</p><p><a href="/docs/guide">返回指南</a></p>`),
  },
  '/docs/api': {
    type: 'text/html',
    body: page('API', `<h1>API</h1><p>${FILLER}</p><p><a href="/docs">返回文档</a></p>`),
  },
  '/team': {
    type: 'text/html',
    body: page('团队', `<h1>团队</h1><p>${FILLER}</p><p><a href="/about">关于</a></p>`),
  },
  // 纯 JS 渲染页：静态 HTML 里没有任何链接，必须靠 Playwright 渲染后才发现子节点
  '/spa': {
    type: 'text/html',
    body: `<!doctype html><html><head><meta charset="utf-8"><title>SPA 页面</title></head>
      <body><div id="root"></div>
      <script>
        // 内联脚本：不依赖外部资源，确保渲染回落路径可被独立验证
        document.getElementById('root').innerHTML =
          '<h1>JS 渲染内容</h1><p>${FILLER}</p><p><a href="/js-rendered-child">JS 渲染出的子页</a></p>';
      </script>
      </body></html>`,
  },
  '/js-rendered-child': {
    type: 'text/html',
    body: page('JS 子页', `<h1>JS 渲染出的子页</h1><p>${FILLER}</p><p><a href="/spa">回 SPA 页</a></p>`),
  },
  '/assets/logo.png': { type: 'image/png', body: Buffer.from('89504e470d0a1a0a', 'hex') },
  '/assets/app.js': {
    type: 'application/javascript',
    body: `document.getElementById('root').innerHTML = '<h1>JS 渲染内容</h1><p>${FILLER}</p><p><a href="/js-rendered-child">JS 渲染出的子页</a></p>';`,
  },
  '/assets/vendor.js': { type: 'application/javascript', body: 'console.log("vendor")' },
  '/assets/runtime.js': { type: 'application/javascript', body: 'console.log("runtime")' },
  '/sitemap.xml': { type: 'application/xml', body: '<urlset></urlset>' },
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', origin);
  const path = url.pathname.length > 1 && url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  if (path === '/paged') {
    const current = Number(url.searchParams.get('page') ?? 1);
    const body = page(
      `分页第 ${current} 页`,
      `<h1>分页第 ${current} 页</h1><p>${FILLER}</p><p><a href="/paged?page=${current + 1}">下一页</a></p>`,
    );
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
    return;
  }
  const entry = routes[path];
  if (entry === undefined) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page('未找到', `<h1>404</h1><p>${FILLER}</p><p><a href="/">首页</a></p>`));
    return;
  }
  res.writeHead(200, { 'content-type': entry.type });
  res.end(entry.body);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`演示站点已启动：${origin}/`);
});
