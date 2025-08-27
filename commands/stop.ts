import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { BotCommandInterface } from '../BotCommandInterface';
import { log } from '../lib';

export default {
  data: new SlashCommandBuilder().setName('stop').setDescription('Stop the Factorio server'),
  async execute(interaction: ChatInputCommandInteraction, bot: BotCommandInterface) {
    log('stop command invoked');
    await interaction.deferReply();
    await bot.stop(interaction);
    log('stop command completed');
  }
};
