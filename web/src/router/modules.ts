/**
 * 模块注册表：界面模块名 = 路由名 = 目录名（requirements §2 / §7 命名一致性）
 * 目录对应 web/src/modules/<module>/ —— 新增模块时这里与目录同时出现，避免命名漂移。
 *
 * `milestone` 是已交付的里程碑标记：导航据此决定「可进入 / 提示未开放」。
 */
export type ModuleKey = 'sites' | 'crawl' | 'tree' | 'data' | 'rules' | 'export' | 'settings';

export interface ModuleDef {
  key: ModuleKey;
  /** 界面名称（中文显示名） */
  label: string;
  /** 路由前缀，与 requirements §2 表格逐字一致 */
  path: string;
  icon: string;
  /** 交付该模块的里程碑 */
  milestone: 'M0' | 'M1' | 'M2' | 'M3' | 'M4';
  /** 该模块下可直接点击的导航项（站点级模块依赖选中站点） */
  perSite: boolean;
  /** 是否已可用（false = 导航可见但点击提示未开放） */
  ready: boolean;
}

export const MODULES: ModuleDef[] = [
  { key: 'sites', label: '站点', path: '/sites', icon: '▦', milestone: 'M0', perSite: false, ready: true },
  { key: 'crawl', label: '采集', path: '/crawl', icon: '⇣', milestone: 'M1', perSite: true, ready: true },
  { key: 'tree', label: '结构', path: '/tree', icon: '⌥', milestone: 'M1', perSite: true, ready: true },
  { key: 'data', label: '数据', path: '/data', icon: '▤', milestone: 'M4', perSite: true, ready: false },
  { key: 'rules', label: '规则', path: '/rules', icon: '⚙', milestone: 'M1', perSite: true, ready: false },
  { key: 'export', label: '导出', path: '/export', icon: '⤴', milestone: 'M4', perSite: true, ready: true },
  { key: 'settings', label: '设置', path: '/settings', icon: '⚒', milestone: 'M1', perSite: false, ready: false },
];

export const moduleByKey = (key: ModuleKey): ModuleDef => {
  const found = MODULES.find((m) => m.key === key);
  if (found === undefined) throw new Error(`未知模块：${key}`);
  return found;
};
