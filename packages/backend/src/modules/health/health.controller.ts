import { Request, Response } from 'express';
import { Pool } from 'pg';
import { Redis } from 'ioredis';

export function createHealthHandler(db: Pool, redis: Redis) {
  return async (_req: Request, res: Response) => {
    const healthStatus: {
      status: 'OK' | 'DEGRADED';
      environment: string;
      region: string;
      checks: {
        postgis: { ok: boolean; latencyMs: number | null; error?: string };
        redis: { ok: boolean; latencyMs: number | null; error?: string };
      };
      timestamp: string;
    } = {
      status: 'OK',
      environment: process.env.NODE_ENV || 'staging',
      region: process.env.RENDER_REGION || 'eu-central-1',
      checks: {
        postgis: { ok: false, latencyMs: null },
        redis: { ok: false, latencyMs: null },
      },
      timestamp: new Date().toISOString(),
    };

    // 1. Verificación aislada de PostgreSQL + PostGIS
    try {
      const startDb = process.hrtime.bigint();
      await db.query('SELECT 1');
      healthStatus.checks.postgis.ok = true;
      healthStatus.checks.postgis.latencyMs = Number(
        (Number(process.hrtime.bigint() - startDb) / 1e6).toFixed(2)
      );
    } catch (dbErr: any) {
      healthStatus.status = 'DEGRADED';
      healthStatus.checks.postgis.error = dbErr?.message || 'DB_CONNECTION_FAILED';
    }

    // 2. Verificación aislada de Redis
    try {
      const startRedis = process.hrtime.bigint();
      await redis.ping();
      healthStatus.checks.redis.ok = true;
      healthStatus.checks.redis.latencyMs = Number(
        (Number(process.hrtime.bigint() - startRedis) / 1e6).toFixed(2)
      );
    } catch (redisErr: any) {
      healthStatus.status = 'DEGRADED';
      healthStatus.checks.redis.error = redisErr?.message || 'REDIS_CONNECTION_FAILED';
    }

    const httpCode = healthStatus.status === 'OK' ? 200 : 503;
    return res.status(httpCode).json(healthStatus);
  };
}
