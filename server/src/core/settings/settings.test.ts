/**
 * 设置模块测试（导航「设置」：全局默认 + 导出预设）
 *
 * 覆盖：默认值补齐、校验（整批拒绝、未知键拒绝、范围/枚举/布尔/字符串）、
 * 恢复默认、默认预设只覆盖标记为 inPreset 的字段（护栏不被悄悄放宽）、
 * 导出预设的增删查与「设为默认」互斥。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CRAWL_PRESET, SETTING_FIELDS } from '@siteatlas/shared';
import { openDb, type DbHandle } from '../store/db.ts';
import { SettingsRepo, normalizeSetting, withDefaults } from '../store/repos/settings.ts';
import { SettingsService } from './service.ts';

interface Ctx {
  handle: DbHandle;
  service: SettingsService;
  cleanup(): void;
}

function makeCtx(): Ctx {
  const handle = openDb({ file: ':memory:' });
  return {
    handle,
    service: new SettingsService({ db: handle.db }),
    cleanup() {
      handle.close();
    },
  };
}

test('设置：缺省值来自 SETTING_FIELDS（§4.7 默认并发 5、间隔 ≥1s、UA 可配）', () => {
  const ctx = makeCtx();
  try {
    const settings = ctx.service.get();
    assert.equal(settings['concurrency'], 5);
    assert.equal(settings['minDelayMs'], 1000);
    assert.equal(settings['perHostConcurrency'], 2);
    assert.equal(settings['respectRobots'], true);
    assert.equal(settings['renderMode'], 'auto');
    assert.equal(settings['theme'], 'system');
    assert.equal(typeof settings['userAgent'], 'string');
    // 每一项都必须有默认值，否则界面会出现空控件
    for (const field of SETTING_FIELDS) {
      assert.ok(settings[field.key] !== undefined, `设置项 ${field.key} 缺少默认值`);
    }
  } finally {
    ctx.cleanup();
  }
});

test('设置：更新落库并立即可读；未知键与非法值整批拒绝（不写库）', () => {
  const ctx = makeCtx();
  try {
    const updated = ctx.service.update({ concurrency: 8, theme: 'dark', respectRobots: false });
    assert.equal(updated['concurrency'], 8);
    assert.equal(updated['theme'], 'dark');
    assert.equal(updated['respectRobots'], false);
    assert.equal(ctx.service.get()['concurrency'], 8, '重新读取应拿到写入值');

    // 未知键
    assert.throws(
      () => ctx.service.update({ nope: 1 } as unknown as Record<string, unknown>),
      (err: Error & { code?: string }) => err.code === 'UNKNOWN_SETTING',
    );
    // 越界：整批拒绝，前一条也不能生效
    assert.throws(
      () => ctx.service.update({ maxDepth: 2, concurrency: 999 } as unknown as Record<string, unknown>),
      (err: Error & { code?: string }) => err.code === 'INVALID_SETTING',
    );
    assert.equal(ctx.service.get()['maxDepth'], 5, '被拒绝的批次不应留下半套设置');
    // 类型不对
    assert.throws(
      () => ctx.service.update({ respectRobots: 'yes' } as unknown as Record<string, unknown>),
      (err: Error & { code?: string }) => err.code === 'INVALID_SETTING',
    );
    // 枚举不对
    assert.throws(
      () => ctx.service.update({ theme: 'blue' } as unknown as Record<string, unknown>),
      (err: Error & { code?: string }) => err.code === 'INVALID_SETTING',
    );
    // 空字符串
    assert.throws(
      () => ctx.service.update({ userAgent: '   ' } as unknown as Record<string, unknown>),
      (err: Error & { code?: string }) => err.code === 'INVALID_SETTING',
    );
  } finally {
    ctx.cleanup();
  }
});

test('设置：恢复默认会删掉设置行，读回默认值', () => {
  const ctx = makeCtx();
  try {
    ctx.service.update({ concurrency: 9, maxDepth: 2 });
    const rows = ctx.handle.db.prepare('SELECT COUNT(*) AS c FROM settings').get() as { c: number };
    assert.equal(Number(rows.c), 2);

    const reset = ctx.service.reset();
    assert.equal(reset['concurrency'], 5);
    assert.equal(reset['maxDepth'], 5);
    const after = ctx.handle.db.prepare('SELECT COUNT(*) AS c FROM settings').get() as { c: number };
    assert.equal(Number(after.c), 0);
  } finally {
    ctx.cleanup();
  }
});

test('设置 → 抓取默认值：只覆盖 inPreset 的字段，护栏沿用内置默认', () => {
  const ctx = makeCtx();
  try {
    ctx.service.update({ concurrency: 7, minDelayMs: 1500, userAgent: 'MyBot/1.0', theme: 'dark' });
    const fallback = ctx.service.crawlFallback();
    assert.equal(fallback.concurrency, 7, '并发应跟随设置');
    assert.equal(fallback.minDelayMs, 1500, '限速应跟随设置');
    assert.equal(fallback.userAgent, 'MyBot/1.0', 'UA 应跟随设置');
    // theme 不在预设里：不能污染抓取参数
    assert.equal((fallback as unknown as Record<string, unknown>)['theme'], undefined);
    // 未在设置里出现的字段保持 §6.3 的内置默认
    assert.equal(fallback.maxPages, DEFAULT_CRAWL_PRESET.maxPages);
    assert.equal(fallback.prefixPruneThreshold, DEFAULT_CRAWL_PRESET.prefixPruneThreshold);
  } finally {
    ctx.cleanup();
  }
});

test('设置：素材归档开关默认开，可关闭', () => {
  const ctx = makeCtx();
  try {
    assert.equal(ctx.service.archiveMaterials(), true);
    ctx.service.update({ archiveMaterials: false });
    assert.equal(ctx.service.archiveMaterials(), false);
  } finally {
    ctx.cleanup();
  }
});

test('导出预设：增删查 + 设为默认互斥 + 非法载荷拒绝', () => {
  const ctx = makeCtx();
  try {
    const first = ctx.service.createExportPreset({ name: 'CSV 全站', payload: { format: 'csv', scope: 'site', includeDeleted: false } });
    assert.equal(first.name, 'CSV 全站');
    assert.equal(first.payload.format, 'csv');
    assert.equal(first.id.length, 26, '预设 id 用 ULID');

    const second = ctx.service.createExportPreset({ name: 'SQLite 默认', payload: { format: 'sqlite', scope: 'site' }, isDefault: true });
    const list = ctx.service.listExportPresets();
    assert.equal(list.length, 2);
    assert.equal(list[0]?.id, second.id, '默认预设排在最前');
    assert.equal(list.filter((p) => p.isDefault).length, 1, '默认预设必须唯一');

    // 再设一个默认 → 前一个自动取消
    const third = ctx.service.createExportPreset({ name: 'Mermaid', payload: { format: 'mermaid', scope: 'subtree' }, isDefault: true });
    const list2 = ctx.service.listExportPresets();
    assert.equal(list2.filter((p) => p.isDefault).length, 1);
    assert.equal(list2[0]?.id, third.id);

    // 非法格式 / 缺名字
    assert.throws(
      () => ctx.service.createExportPreset({ name: '坏的', payload: { format: 'xml' } }),
      (err: Error & { code?: string }) => err.code === 'INVALID_PRESET',
    );
    assert.throws(
      () => ctx.service.createExportPreset({ payload: { format: 'json' } }),
      (err: Error & { code?: string }) => err.code === 'INVALID_PRESET',
    );

    // 删除
    assert.equal(ctx.service.deleteExportPreset(first.id), true);
    assert.equal(ctx.service.deleteExportPreset(first.id), false);
    assert.equal(ctx.service.listExportPresets().length, 2);
  } finally {
    ctx.cleanup();
  }
});

test('设置仓储：坏 JSON 不炸（回落默认值），布尔值不因字符串化而变真', () => {
  const ctx = makeCtx();
  try {
    const repo = new SettingsRepo(ctx.handle.db);
    ctx.handle.db.prepare('INSERT INTO settings (k, v) VALUES (?, ?)').run('concurrency', 'not-json');
    assert.equal(ctx.service.get()['concurrency'], 5, '坏值应回落默认');

    repo.put('respectRobots', false);
    assert.equal(ctx.service.get()['respectRobots'], false, 'false 不能被读成 true');

    // withDefaults 只补缺失项
    const merged = withDefaults(SETTING_FIELDS, { concurrency: 11 });
    assert.equal(merged['concurrency'], 11);
    assert.equal(merged['minDelayMs'], 1000);

    // normalizeSetting 的边界
    const concurrencyField = SETTING_FIELDS.find((f) => f.key === 'concurrency');
    assert.ok(concurrencyField !== undefined);
    assert.deepEqual(normalizeSetting(concurrencyField, 5.6), { ok: true, value: 6 });
    assert.equal(normalizeSetting(concurrencyField, 0).ok, false);
    assert.equal(normalizeSetting(concurrencyField, 33).ok, false);
  } finally {
    ctx.cleanup();
  }
});
