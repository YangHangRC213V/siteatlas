/**
 * api/routes/settings.ts —— 全局设置接口（导航「设置」模块）
 *
 * | GET    | /api/settings                | 当前设置（缺失项已补默认值）+ 表单元数据 |
 * | PUT    | /api/settings                | 批量更新（全量校验通过才写库）           |
 * | POST   | /api/settings/reset          | 恢复默认（删除设置行）                   |
 * | GET    | /api/presets/export          | 导出预设列表（§4 presets, kind='export'）|
 * | POST   | /api/presets/export          | 保存导出预设（可设为默认）               |
 * | DELETE | /api/presets/export/:presetId| 删除导出预设                             |
 *
 * 设置是**全局**的（不带 siteId）：它是「这台机器上这个工具的默认行为」，
 * 站点级参数（范围/白名单）在站点记录里，避免两处都能改同一个东西（见 DECISIONS.md）。
 */
import type { FastifyInstance } from 'fastify';
import { SETTING_FIELDS } from '@siteatlas/shared';
import type { SettingsService } from '../../core/settings/service.ts';

export async function registerSettingsRoutes(app: FastifyInstance, settings: SettingsService): Promise<void> {
  app.get('/api/settings', async () => ({ settings: settings.get(), fields: SETTING_FIELDS }));

  app.put<{ Body: { settings: Record<string, unknown> } }>(
    '/api/settings',
    {
      schema: {
        body: {
          type: 'object',
          required: ['settings'],
          additionalProperties: false,
          properties: { settings: { type: 'object', additionalProperties: true } },
        },
        response: { 200: { type: 'object', additionalProperties: true, properties: { settings: { type: 'object', additionalProperties: true } } } },
      },
    },
    async (request) => ({ settings: settings.update(request.body.settings) }),
  );

  app.post('/api/settings/reset', async () => ({ settings: settings.reset() }));

  app.get('/api/presets/export', async () => ({ presets: settings.listExportPresets() }));

  app.post<{ Body: { name?: string; payload?: unknown; isDefault?: boolean } }>(
    '/api/presets/export',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'payload'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 60 },
            payload: { type: 'object', additionalProperties: true },
            isDefault: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const preset = settings.createExportPreset(request.body);
      reply.code(201);
      return { preset };
    },
  );

  app.delete<{ Params: { presetId: string } }>('/api/presets/export/:presetId', async (request, reply) => {
    const deleted = settings.deleteExportPreset(request.params.presetId);
    if (!deleted) {
      reply.code(404);
      return { error: { code: 'PRESET_NOT_FOUND', message: `预设不存在：${request.params.presetId}` } };
    }
    return { deleted: true };
  });
}
