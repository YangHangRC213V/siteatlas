/**
 * tests/fixture-site.ts —— 本地测试站点（M1 集成测试用）
 *
 * 刻意覆盖采集最容易出错的情况：
 *   - 多级结构（深度 0/1/2）
 *   - 同一目标被多个页面链接（入链 ≥2，父节点必须按「首次发现」确定）
 *   - 同一页面用不同跟踪参数/大小写/尾斜杠链接（必须归并成 1 个节点）
 *   - 页内 fragment 链接（不新建节点，只在边里记 fragment）
 *   - 非 HTML 素材（.png / .pdf，记录但不递归）
 *   - 外部域链接（不同主机名，同域策略必须过滤）
 *   - 404 页面（状态 error，不递归）
 *   - robots.txt 禁止路径（状态 blocked）
 *   - SPA 型页面（静态无链接，用于渲染回落判定）
 *   - 分页 ?page=n（用于分页护栏）
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeSite {
  origin: string;
  host: string;
  port: number;
  /** 每个路径被请求的次数（用于断言去重确实少发了请求） */
  hits: Map<string, number>;
  close(): Promise<void>;
}

const PAGE = (title: string, body: string, extraHead = ''): string => `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>${title}</title>${extraHead}</head>
<body><main>${body}</main></body></html>`;

/** 正文足够的段落，便于内容指纹生效（< 64 字符的正文不参与内容去重） */
const FILLER =
  '本站点用于 SiteAtlas 采集内核的集成测试。段落内容需要足够长，以便正文指纹计算生效，' +
  '从而验证内容去重层不会误伤结构去重层。';

function routes(origin: string): Record<string, { type: string; body: string | Buffer; status?: number }> {
  return {
    '/robots.txt': {
      type: 'text/plain',
      body: 'User-agent: *\nDisallow: /blocked/\nCrawl-delay: 0\n\nSitemap: ' + origin + '/sitemap.xml\n',
    },
    '/': {
      type: 'text/html',
      body: PAGE(
        '首页',
        `<h1>首页</h1><p>${FILLER}</p>
         <nav>
           <a href="/about">关于我们</a>
           <a href="/docs">文档</a>
           <a href="/team">团队</a>
           <a href="/spa">SPA 页面</a>
           <a href="http://localhost:1/outside">外域链接</a>
           <a href="/missing">不存在的页面</a>
           <a href="/blocked/secret">robots 禁止页</a>
           <a href="/assets/logo.png">Logo 图片</a>
           <a href="/paged?page=1">分页列表</a>
         </nav>`,
      ),
    },
    '/about': {
      type: 'text/html',
      body: PAGE(
        '关于我们',
        `<h1>关于</h1><p>${FILLER}</p>
         <p><a href="/">回首页</a></p>
         <p><a href="/team">团队</a></p>
         <p><a href="/docs">文档</a></p>
         <p><a href="/assets/logo.png">同一张图片（另一页也链接）</a></p>
         <p><a href="/assets/report.pdf">PDF 附件</a></p>`,
      ),
    },
    '/docs': {
      type: 'text/html',
      body: PAGE(
        '文档',
        `<h1>文档</h1><p>${FILLER}</p>
         <ul>
           <li><a href="/docs/guide">指南</a></li>
           <li><a href="/docs/api/">API</a></li>
           <li><a href="/docs/guide#step-2">指南的第二步（页内锚点）</a></li>
           <li><a href="/docs/guide?utm_source=news&utm_medium=email">指南（带跟踪参数）</a></li>
           <li><a href="/docs/guide/">指南（尾斜杠变体）</a></li>
           <li><a href="/docs/guide#step-3">指南的第三步</a></li>
           <li><a href="/docs/guide?a=1&amp;b=2">指南（真实 query，应与上者视为不同资源）</a></li>
         </ul>`,
      ),
    },
    '/docs/guide': {
      type: 'text/html',
      body: PAGE(
        '指南',
        `<h1>指南</h1><p>${FILLER}</p>
         <p><a href="/docs/guide/install">安装</a></p>
         <p><a href="/docs">返回文档</a></p>`,
      ),
    },
    '/docs/guide/install': {
      type: 'text/html',
      body: PAGE('安装', `<h1>安装</h1><p>${FILLER}</p><p><a href="/docs/guide">返回指南</a></p>`),
    },
    '/docs/api': {
      type: 'text/html',
      body: PAGE('API', `<h1>API</h1><p>${FILLER}</p><p><a href="/docs">返回文档</a></p>`),
    },
    '/team': {
      type: 'text/html',
      body: PAGE('团队', `<h1>团队</h1><p>${FILLER}</p><p><a href="/about">关于</a></p>`),
    },
    '/spa': {
      type: 'text/html',
      body: `<!doctype html><html><head><title>SPA</title>
        <script src="/assets/app.js"></script><script src="/assets/vendor.js"></script><script src="/assets/runtime.js"></script>
        </head><body><div id="root"></div></body></html>`,
    },
    '/assets/logo.png': { type: 'image/png', body: Buffer.from('89504e470d0a1a0a', 'hex') },
    '/assets/report.pdf': { type: 'application/pdf', body: Buffer.from('%PDF-1.4\n', 'utf8') },
    '/assets/app.js': { type: 'application/javascript', body: 'console.log(1)' },
    '/assets/vendor.js': { type: 'application/javascript', body: 'console.log(2)' },
    '/assets/runtime.js': { type: 'application/javascript', body: 'console.log(3)' },
    '/sitemap.xml': { type: 'application/xml', body: '<urlset></urlset>' },
  };
}

/** 启动本地站点；返回 origin 与请求计数 */
export async function startFakeSite(
  extra: Record<string, { type: string; body: string | Buffer; status?: number }> = {},
): Promise<FakeSite> {
  const hits = new Map<string, number>();
  let routeTable: Record<string, { type: string; body: string | Buffer; status?: number }> = {};

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://placeholder');
    const path = url.pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    // 去尾斜杠后查表：真实站点里 /about/ 与 /about 通常等价
    const lookup = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
    let entry = routeTable[lookup];
    if (entry === undefined && path.startsWith('/paged')) {
      entry = {
        type: 'text/html',
        body: PAGE(
          `分页 ${url.searchParams.get('page') ?? '1'}`,
          `<h1>分页</h1><p>${FILLER}</p><p><a href="/paged?page=${Number(url.searchParams.get('page') ?? 1) + 1}">下一页</a></p>`,
        ),
      };
    }
    if (entry === undefined) {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end(PAGE('未找到', `<h1>404</h1><p>${FILLER}</p><p><a href="/">首页</a></p>`));
      return;
    }
    res.writeHead(entry.status ?? 200, { 'content-type': entry.type });
    res.end(entry.body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  routeTable = { ...routes(origin), ...extra };

  return {
    origin,
    host: `127.0.0.1:${address.port}`,
    port: address.port,
    hits,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
