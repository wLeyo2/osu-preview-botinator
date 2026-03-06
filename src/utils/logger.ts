import pino from 'pino';
import config from '@/utils/config';

const isProduction = process.env.NODE_ENV === 'production';
const prettyLogs = !isProduction && process.stdout.isTTY;

const logger = pino({
  level: config.showDebug ? 'debug' : 'info',
  ...(prettyLogs
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:dd-mm-yyyy HH:MM:ss',
            ignore: 'pid,hostname',
            singleLine: true,
          },
        },
      }
    : {}),
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: {
    err: (err) => ({
      stack: err.stack,
    }),
  },
});

export default logger;
