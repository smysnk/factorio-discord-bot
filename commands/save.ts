import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { listBackupNames, log } from '../lib';
import { BotCommandInterface } from '../BotCommandInterface';

export default {
  data: new SlashCommandBuilder()
    .setName('save')
    .setDescription('Save the server with an optional name')
    .addStringOption(o =>
      o
        .setName('name')
        .setDescription('Save name')
        .setAutocomplete(true)
        .setRequired(false)
    ),
  async autocomplete(interaction: any) {
    const focused = interaction.options.getFocused();
    const names = await listBackupNames();
    const filtered = names
      .filter((n: string) => n.startsWith(focused))
      .slice(0, 24);
    const options = (focused
      ? [focused, ...filtered.filter((n: string) => n !== focused)]
      : filtered
    )
      .map((n: string) => ({ name: n, value: n }))
      .slice(0, 25);
    await interaction.respond(options);
  },
  async execute(interaction: ChatInputCommandInteraction, bot: BotCommandInterface) {
    log('save command invoked');
    await interaction.deferReply();
    const name = interaction.options.getString('name');
    await bot.save(interaction, name);
    log('save command completed');
  }
};
