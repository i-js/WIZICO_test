import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module';
import { webOrigins } from './config';

async function main() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: webOrigins, credentials: true });
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    if (origin && !webOrigins.includes(origin)) {
      res.status(403).json({ message: 'Origin is not allowed' });
      return;
    }
    next();
  });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3101), '0.0.0.0');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
