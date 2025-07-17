# Factorio Discord Bot

This project contains a simple Discord bot that can manage a Factorio game server hosted on AWS EC2. The bot is implemented in **Node.js** using `discord.js`, the AWS SDK, `ssh2` and `dotenv`. These dependencies must be installed in your environment along with valid AWS and Discord credentials stored in a `.env` file.

## Configuration

1. Copy `.env.example` to `.env` and fill in the required values.
2. Adjust `ec2_template.json` to match the EC2 instance you want to launch.
   The bot automatically loads variables from `.env` when it starts.
3. Set `DOCKER_IMAGE` to the Factorio Docker image you wish to run
   (e.g. `factoriotools/factorio:latest`).
4. Configure `BACKUP_UPLOAD_URL` and `BACKUP_DOWNLOAD_URL` with endpoints that
   accept authenticated `curl` uploads and downloads. Provide the matching
   `BACKUP_UPLOAD_AUTH_HEADER` and `BACKUP_DOWNLOAD_AUTH_HEADER` values to
   include in the requests.

## Running the Bot

Install the required packages and run `bot.js`:

```bash
npm install
node bot.js
```

The bot uses slash commands which are registered automatically on startup. Use
`/start` to launch the server, optionally selecting a prior backup name to
restore. The `/save` and `/stop` commands create a dated archive and player data
file which are uploaded via the configured URLs before shutting down (for
`/stop`). The `/sync` command attempts to pull from the configured git remote
and, if no merge conflicts occur, pushes your local branch. Use
`DISCORD_CHANNEL_ID` to restrict the channel and `DISCORD_GUILD_ID` to limit
registration to a single guild.
