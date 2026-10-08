// voc.js — à mettre dans le dossier "commande" (comme logs.js)
// Dans index.js : require('./commande/voc')(client);
//
// &pv        -> ferme ton vocal : personne ne peut rejoindre tant que tu ne l'as pas quitté
//               (refais &pv pour le rouvrir à la main)
// &mv <id>   -> ramène la personne (ID ou mention) dans ton vocal
//
// Il faut l'intent GuildVoiceStates sur le client.
// Le bot doit avoir : Gérer les salons + Déplacer des membres.
// Pour utiliser les commandes : permission "Déplacer des membres" (admins/owner inclus).

const { PermissionFlagsBits } = require('discord.js');
const fs = require('fs');

module.exports = (client, { prefix = '&', file = './voc-locks.json' } = {}) => {
  let locks = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const save = () => fs.writeFileSync(file, JSON.stringify(locks, null, 2));

  // Rouvre un vocal (remet la permission "Se connecter" comme avant)
  async function unlock(guild, channelId) {
    const lock = locks[channelId];
    if (!lock) return;
    delete locks[channelId];
    save();
    const ch = guild.channels.cache.get(channelId);
    if (!ch) return;
    await ch.permissionOverwrites
      .edit(guild.roles.everyone, { Connect: lock.prev }, { reason: 'Vocal rouvert' })
      .catch(() => {});
  }

  client.on('messageCreate', async (msg) => {
    if (!msg.guild || msg.author.bot || !msg.content.startsWith(prefix)) return;

    const args = msg.content.slice(prefix.length).trim().split(/\s+/);
    const cmd = args.shift()?.toLowerCase();
    if (cmd !== 'pv' && cmd !== 'mv') return;

    if (!msg.member.permissions.has(PermissionFlagsBits.MoveMembers))
      return msg.reply('❌ Il faut la permission **Déplacer des membres**.');

    const myChannel = msg.member.voice.channel;
    if (!myChannel) return msg.reply('❌ Tu dois être dans un salon vocal.');

    /* &pv : ferme / rouvre ton vocal */
    if (cmd === 'pv') {
      if (locks[myChannel.id]) {
        await unlock(msg.guild, myChannel.id);
        return msg.reply(`🔓 **${myChannel.name}** est rouvert.`);
      }

      const ow = myChannel.permissionOverwrites.cache.get(msg.guild.id);
      let prev = null;
      if (ow?.allow.has(PermissionFlagsBits.Connect)) prev = true;
      else if (ow?.deny.has(PermissionFlagsBits.Connect)) prev = false;

      try {
        await myChannel.permissionOverwrites.edit(
          msg.guild.roles.everyone,
          { Connect: false },
          { reason: `&pv par ${msg.author.tag}` }
        );
      } catch {
        return msg.reply('❌ Impossible de fermer ce vocal (le bot doit avoir **Gérer les salons**).');
      }

      locks[myChannel.id] = { owner: msg.author.id, prev };
      save();
      return msg.reply(`🔒 **${myChannel.name}** est fermé. Personne ne peut venir tant que tu ne l'as pas quitté.`);
    }

    /* &mv <id> : ramène quelqu'un dans ton vocal */
    const targetId = msg.mentions.users.first()?.id || args[0];
    if (!targetId || !/^\d{17,20}$/.test(targetId))
      return msg.reply(`Utilisation : \`${prefix}mv ID\` (ou mention)`);

    const target = await msg.guild.members.fetch(targetId).catch(() => null);
    if (!target) return msg.reply("❌ Je ne trouve pas cette personne sur le serveur.");
    if (!target.voice.channel) return msg.reply("❌ Cette personne n'est dans aucun salon vocal.");
    if (target.voice.channelId === myChannel.id) return msg.reply('⚠️ Elle est déjà dans ton vocal.');

    try {
      await target.voice.setChannel(myChannel, `&mv par ${msg.author.tag}`);
      return msg.reply(`✅ <@${target.id}> a été ramené dans **${myChannel.name}**.`);
    } catch {
      return msg.reply('❌ Impossible de la déplacer (le bot doit avoir **Déplacer des membres**).');
    }
  });

  // Rouvre automatiquement quand le propriétaire quitte, ou quand le vocal est vide
  client.on('voiceStateUpdate', async (oldState, newState) => {
    const channelId = oldState.channelId;
    const lock = channelId && locks[channelId];
    if (!lock || channelId === newState.channelId) return;

    const ch = oldState.guild.channels.cache.get(channelId);
    if (oldState.id === lock.owner || !ch || ch.members.size === 0) {
      await unlock(oldState.guild, channelId);
    }
  });
};
