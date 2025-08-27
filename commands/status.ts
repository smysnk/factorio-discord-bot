import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { BotCommandInterface } from '../BotCommandInterface';
import { log } from '../lib';

export default {
  data: new SlashCommandBuilder().setName('status').setDescription('Get server status'),
  async execute(interaction: ChatInputCommandInteraction, bot: BotCommandInterface) {
    log('status command invoked');
    await interaction.deferReply();
    await bot.status(interaction);
    log('status command completed');
  }
};
