import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/error';
import { authRouter } from './routes/auth';
import { campaignsRouter } from './routes/campaigns';
import { emailsRouter } from './routes/emails';
import { healthRouter } from './routes/health';
import { rootRouter } from './routes/root';
import { sendersRouter } from './routes/senders';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(
    cors({
      origin: [env.APP_URL],
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(cookieParser());
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/health' },
    }),
  );

  app.use('/', rootRouter);
  app.use('/health', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/campaigns', campaignsRouter);
  app.use('/api/emails', emailsRouter);
  app.use('/api/senders', sendersRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
