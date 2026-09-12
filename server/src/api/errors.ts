/**
 * HTTP 错误映射（dev-spec §5.1）
 *
 * 用例层抛 SiteServiceError（带 code/status/detail），此处统一落成契约错误体：
 * `{ error: { code, message, detail? } }`
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SiteServiceError } from '../core/sites/service.ts';
import { CrawlControlError } from '../core/crawl/control.ts';
import { OverrideError } from '../core/override/overrides.ts';
import { ManualError } from '../core/manual/service.ts';
import { CrawlError } from '../core/crawl/service.ts';
import { InvalidUrlError } from '../core/url/normalize.ts';

export interface ApiErrorBody {
  error: { code: string; message: string; detail?: unknown };
}

export function apiError(code: string, message: string, detail?: unknown): ApiErrorBody {
  return detail === undefined ? { error: { code, message } } : { error: { code, message, detail } };
}

/** Fastify 错误处理器：把领域错误映射为状态码，其余按 500 处理 */
export function errorHandler(
  error: Error & { statusCode?: number; validation?: unknown; code?: string },
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error instanceof SiteServiceError) {
    reply
      .code(error.status)
      .send(apiError(error.code, error.message, error.detail));
    return;
  }
  if (error instanceof CrawlError) {
    reply.code(error.status).send(apiError(error.code, error.message));
    return;
  }
  if (error instanceof CrawlControlError) {
    reply.code(error.status).send(apiError(error.code, error.message));
    return;
  }
  if (error instanceof OverrideError) {
    reply.code(error.status).send(apiError(error.code, error.message));
    return;
  }
  if (error instanceof ManualError) {
    reply.code(error.status).send(apiError(error.code, error.message));
    return;
  }
  if (error instanceof InvalidUrlError) {
    reply.code(400).send(apiError('INVALID_URL', error.message));
    return;
  }
  if (error.validation !== undefined) {
    reply.code(400).send(apiError('INVALID_BODY', '请求体校验失败', error.validation));
    return;
  }
  request.log.error({ err: error }, '未处理的服务端错误');
  const status = typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
  reply.code(status).send(apiError(error.code ?? 'INTERNAL_ERROR', error.message));
}
