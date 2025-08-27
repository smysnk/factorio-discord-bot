import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Client, GatewayIntentBits, Events, ChatInputCommandInteraction } from 'discord.js';
import { sendReply, log } from './lib';
import { ProviderStrategy } from './strategies/ProviderStrategy';
import { BotCommandInterface } from './BotCommandInterface';
import { createProviderStrategy } from './providerFactory';

type Command = {
  data: any;
  autocomplete?: (interaction: any) => Promise<void>;
  execute: (interaction: any, bot: BotCommandInterface) => Promise<void>;
};

const channelId = process.env.DISCORD_CHANNEL_ID;
const guildId = process.env.DISCORD_GUILD_ID;

export class Bot implements BotCommandInterface {
  client: Client;
  provider: ProviderStrategy;
  commands: Map<string, Command>;

  constructor() {
    this.client = new Client({ intents: [GatewayIntentBits.Guilds] });
    this.provider = createProviderStrategy();
    this.commands = new Map();

    const commandFiles = fs
      .readdirSync(path.join(__dirname, 'commands'))
      .filter(f => f.endsWith('.ts'));
    for (const file of commandFiles) {
      const command: Command = require(`./commands/${file}`).default;
      this.commands.set(command.data.name, command);
    }

    this.client.once(Events.ClientReady, async () => {
      log(`Logged in as ${this.client.user?.tag}`);
      const data = Array.from(this.commands.values()).map(c => c.data.toJSON());
      if (guildId) {
        await this.client.application!.commands.set(data, guildId);
      } else {
        await this.client.application!.commands.set(data);
      }
    });

    this.client.on(Events.InteractionCreate, async interaction => {
      if (!interaction.isChatInputCommand() && !interaction.isAutocomplete()) return;
      if (interaction.channelId !== channelId) return;

      const { commandName } = interaction;
      log('Received interaction', commandName);
      const command = this.commands.get(commandName);
      if (!command) return;

      if (interaction.isAutocomplete()) {
        if (command.autocomplete) {
          await command.autocomplete(interaction);
        }
        return;
      }

      try {
        await command.execute(interaction, this);
        log('Command executed', commandName);
      } catch (err: any) {
        console.error(err);
        log('Interaction error', err.message);
        const msg = 'Error: ' + err.message;
        await sendReply(interaction, msg, { ephemeral: true });
      }
    });
  }

  async start(interaction: ChatInputCommandInteraction, backup?: string | null, version?: string | null) {
    await this.provider.start(interaction, backup, version);
  }

  async stop(interaction: ChatInputCommandInteraction) {
    await this.provider.stop(interaction);
  }

  async status(interaction: ChatInputCommandInteraction) {
    await this.provider.status(interaction);
  }

  async save(interaction: ChatInputCommandInteraction, name?: string | null) {
    await this.provider.save(interaction, name);
  }

  async login() {
    await this.client.login(process.env.DISCORD_TOKEN);
  }
}

const bot = new Bot();
bot.login();
