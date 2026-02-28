import path from 'node:path';
import { REST, Routes } from 'discord.js';
import config from '@/utils/config';
import logger from '../logger';
import { getAllFiles } from './getAllFiles';

logger.info('Starting command deployment script...');

if (!config.token) throw new Error('Missing required env variable: TOKEN');
if (!config.clientId)
  throw new Error('Missing required env variable: CLIENT_ID');

const commands = [];
const commandsPath = path.join(__dirname, '../..', 'commands');
const commandFiles = getAllFiles(commandsPath);

for (const filePath of commandFiles) {
  const { command } = await import(filePath);
  if (command && 'data' in command) {
    commands.push(command.data.toJSON());
  } else {
    logger.warn(
      `The command at ${filePath} is missing a required "data" property.`,
    );
  }
}

if (commands.length === 0) {
  logger.info('No commands found to deploy. Exiting.');
  process.exit(0);
}

const rest = new REST().setToken(config.token);

const isGlobalDeploy = process.argv.includes('--global') || !config.guildId;

(async () => {
  try {
    logger.info(
      `Started refreshing ${commands.length} application (/) commands.`,
    );

    if (isGlobalDeploy) {
      if (!config.guildId) {
        logger.info(
          'GUILD_ID not set — deploying globally (may take up to 1 hour to propagate).',
        );
      } else {
        logger.info('--global flag set — deploying globally.');
      }
      await rest.put(Routes.applicationCommands(config.clientId), {
        body: commands,
      });
      logger.info('Successfully deployed commands globally.');
    } else {
      const guildIds = config.guildId
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      logger.info(`Deploying commands to ${guildIds.length} guild(s)...`);

      for (const guildId of guildIds) {
        try {
          await rest.put(
            Routes.applicationGuildCommands(config.clientId, guildId),
            { body: commands },
          );
          logger.info(`Successfully deployed commands to guild: ${guildId}`);
        } catch (err: unknown) {
          const code = (err as { code?: number })?.code;
          if (code === 50001) {
            logger.error(
              `Guild ${guildId}: Missing Access (50001). ` +
                `Make sure the bot is a member of this guild and the ID is correct. ` +
                `Remove GUILD_ID from .env or use --global to deploy globally instead.`,
            );
          } else {
            logger.error(`Guild ${guildId}: ${err}`);
          }
        }
      }
    }
  } catch (error) {
    logger.error(`Error deploying commands: ${error}`);
  }
})();
