import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { DatabaseExceptionFilter } from './common/database-exception.filter';
import { env } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });

  // CSV は base64 で送るため、既定の 100KB では通販CSV（95KB）もAmazonレポート
  // （480KB）も入らない。上限を設定で持たせる。
  app.useBodyParser('json', { limit: `${env.MAX_UPLOAD_MB}mb` });

  app.use(helmet());
  // 画面と API が別オリジン（Vercel＋Render）になる構成では、既定のままだと
  // ブラウザが下の応答ヘッダを読めない。帳票のファイル名や、出荷確定の件数・
  // 同梱できなかった添付の警告はここに載せているため、明示的に公開する。
  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    exposedHeaders: ['Content-Disposition', 'X-Skipped-Attachments', 'X-Confirmed-Shipments'],
  });
  app.setGlobalPrefix('api');
  // データベースが弾いた内容を、意味の分かる応答に変える。
  // 制約に引っかかること自体は正しい動きなので、500 ではなく 400／409 で返す。
  app.useGlobalFilters(new DatabaseExceptionFilter());
  // 入力検証は経路ごとに ZodValidationPipe で行うため、全体パイプは置かない
  // （@nestjs/common の ValidationPipe は class-validator を必要とする）。

  // OnApplicationShutdown を効かせる。接続プールを閉じてから終了する。
  app.enableShutdownHooks();

  await app.listen(env.PORT, '0.0.0.0');

  const logger = new Logger('bootstrap');
  logger.log(`起動しました  http://localhost:${env.PORT}/api  (${env.NODE_ENV})`);
  logger.log(`データベース  スキーマ ${env.DB_SCHEMA}`);
}

void bootstrap();
