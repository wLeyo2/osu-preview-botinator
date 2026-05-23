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

const _isGlobalDeploy = true;

(async () => {
  try {
    logger.info(
      `Started refreshing ${commands.length} application (/) commands globally...`,
    );

    await rest.put(Routes.applicationCommands(config.clientId), {
      body: commands,
    });
    logger.info('Successfully deployed commands globally.');
  } catch (error) {
    logger.error(`Error deploying commands: ${error}`);
  }
})();
