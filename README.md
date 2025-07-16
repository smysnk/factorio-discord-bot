# Factorio Discord Bot

This project contains a simple Discord bot that can manage a Factorio game server hosted on AWS EC2. The bot is implemented in **Node.js** using `discord.js`, the AWS SDK, `ssh2` and `dotenv`. These dependencies must be installed in your environment along with valid AWS and Discord credentials stored in a `.env` file.

## Configuration

1. Copy `.env.example` to `.env` and fill in the required values.
2. Adjust `ec2_template.json` to match the EC2 instance you want to launch.
   The bot automatically loads variables from `.env` when it starts.

## Running the Bot

Install the required packages and run `bot.js`:

```bash
npm install
node bot.js
```

The bot uses slash commands which are registered automatically on startup.
Use `DISCORD_CHANNEL_ID` to restrict the channel and `DISCORD_GUILD_ID` to limit
registration to a single guild.
