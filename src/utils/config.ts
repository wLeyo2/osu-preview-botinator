import { cleanEnv, str } from 'envalid';

const env = cleanEnv(process.env, {
  TOKEN: str(),
  CLIENT_ID: str(),
  GUILD_ID: str({ default: '' }),
  SHOW_DEBUG: str({ default: 'false' }),
});

export default {
  token: env.TOKEN,
  clientId: env.CLIENT_ID,
  guildId: env.GUILD_ID,
  showDebug: env.SHOW_DEBUG === 'true',
};
