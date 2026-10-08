// logs.js — à mettre à côté de ton index.js
// Dans ton index.js, APRÈS avoir créé ton client :
//     require('./logs')(client);
//
// Intents requis sur ton client : Guilds, GuildMembers, GuildModeration,
// GuildMessages, MessageContent
// Partials conseillés : GuildMember, User

const {
  PermissionFlagsBits, ChannelType, EmbedBuilder, AuditLogEvent,
} = require('discord.js');
const fs = require('fs');

module.exports = (client, { prefix = '&', dbFile = './logs-db.json' } = {}) => {
  /* ---------- DB JSON ---------- */
  let db = fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile, 'utf8')) : {};
  const save = () => fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
  const conf = (gid) => (db[gid] ??= { channels: {}, bots: [] });

  const COLORS = { raid: 0xff3b3b, mod: 0xffa500, rank: 0x5865f2, ok: 0x2ecc71 };
  const who = (u) => (u ? `<@${u.id}> (\`${u.tag ?? u.username}\`)` : '`Inconnu`');

  async function sendLog(guild, type, embed) {
    const id = conf(guild.id).channels[type];
    const ch = id && guild.channels.cache.get(id);
    if (!ch) return;
    ch.send({ embeds: [embed.setTimestamp()], allowedMentions: { parse: [] } }).catch(() => {});
  }

  async function getExecutor(guild, action, targetId) {
    try {
      await new Promise((r) => setTimeout(r, 1200));
      const logs = await guild.fetchAuditLogs({ type: action, limit: 6 });
      const e = logs.entries.find(
        (x) => x.target?.id === targetId && Date.now() - x.createdTimestamp < 15000
      );
      return e ? { user: e.executor, reason: e.reason } : null;
    } catch { return null; }
  }

  /* ---------- Commandes ---------- */
  client.on('messageCreate', async (msg) => {
    if (!msg.guild) return;

    // Commandes des bots ajoutés avec &addbotlogs
    if (msg.author.bot) {
      if (conf(msg.guild.id).bots.includes(msg.author.id)) logExternalBot(msg);
      return;
    }
    if (!msg.content.startsWith(prefix)) return;

    const args = msg.content.slice(prefix.length).trim().split(/\s+/);
    const cmd = args.shift().toLowerCase();
    const isAdmin = msg.member.permissions.has(PermissionFlagsBits.Administrator);

    if (cmd === 'adlogs') {
      if (!isAdmin) return msg.reply('❌ Il faut la permission **Administrateur**.');

      const overwrites = [
        { id: msg.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: client.user.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks],
        },
      ];
      const category = await msg.guild.channels.create({
        name: '📁・𝐋𝐎𝐆𝐒', type: ChannelType.GuildCategory, permissionOverwrites: overwrites,
      });
      const make = (name, topic) => msg.guild.channels.create({
        name, topic, type: ChannelType.GuildText, parent: category.id, permissionOverwrites: overwrites,
      });
      const raid = await make('🚨・raid-logs', 'Changements de pdp, pseudos, arrivées/départs');
      const mod = await make('🛡️・modération-logs', 'Bans, mutes, commandes utilisées');
      const rank = await make('🎖️・rank-and-derank', 'Rôles et permissions ajoutés / retirés');

      conf(msg.guild.id).channels = { raid: raid.id, mod: mod.id, rank: rank.id };
      save();
      return msg.reply(`✅ Salons de logs créés : ${raid} ${mod} ${rank}`);
    }

    if (cmd === 'addbotlogs' || cmd === 'delbotlogs') {
      if (!isAdmin) return msg.reply('❌ Il faut la permission **Administrateur**.');
      const bot = msg.mentions.users.first();
      if (!bot?.bot) return msg.reply(`❌ Utilisation : \`${prefix}${cmd} @bot\``);
      const c = conf(msg.guild.id);
      if (cmd === 'addbotlogs') {
        if (c.bots.includes(bot.id)) return msg.reply('⚠️ Ce bot est déjà suivi.');
        c.bots.push(bot.id);
        save();
        return msg.reply(`✅ Les commandes de ${bot} seront loggées.`);
      }
      c.bots = c.bots.filter((id) => id !== bot.id);
      save();
      return msg.reply(`✅ ${bot} n'est plus suivi.`);
    }
  });

  async function logExternalBot(msg) {
    let user = null, text = null;
    const inter = msg.interactionMetadata ?? msg.interaction;
    if (inter) {
      user = inter.user;
      text = `/${msg.interaction?.commandName ?? 'commande'}`;
    } else if (msg.reference?.messageId) {
      const ref = await msg.channel.messages.fetch(msg.reference.messageId).catch(() => null);
      if (ref && !ref.author.bot) { user = ref.author; text = ref.content; }
    }
    if (!user) {
      const last = await msg.channel.messages.fetch({ limit: 6, before: msg.id }).catch(() => null);
      const f = last?.find(
        (m) => !m.author.bot && msg.createdTimestamp - m.createdTimestamp < 5000 && /^[^\w\s]/.test(m.content)
      );
      if (f) { user = f.author; text = f.content; }
    }
    if (!user) return;
    sendLog(msg.guild, 'mod', new EmbedBuilder()
      .setColor(COLORS.mod)
      .setTitle("🤖 Commande d'un bot suivi")
      .setDescription(
        `🤖 Bot : <@${msg.author.id}>\n👤 Utilisateur : ${who(user)}\n💬 \`${String(text).slice(0, 200)}\`\n📍 <#${msg.channel.id}>`
      ));
  }

  /* ---------- RAID LOGS ---------- */
  client.on('userUpdate', (o, n) => {
    const av = o.avatar !== n.avatar, nm = o.username !== n.username;
    if (!av && !nm) return;
    client.guilds.cache.forEach((g) => {
      if (!g.members.cache.has(n.id)) return;
      const e = new EmbedBuilder().setColor(COLORS.raid);
      if (av) e.setTitle('🖼️ Photo de profil modifiée')
        .setDescription(`👤 ${who(n)}`)
        .setThumbnail(o.displayAvatarURL({ size: 256 }))
        .setImage(n.displayAvatarURL({ size: 512 }))
        .setFooter({ text: 'Ancienne pdp en haut à droite • Nouvelle en bas' });
      else e.setTitle('✏️ Pseudo modifié')
        .setDescription(`👤 ${who(n)}\n❌ \`${o.username}\`\n✅ \`${n.username}\``);
      sendLog(g, 'raid', e);
    });
  });

  client.on('guildMemberAdd', (m) => {
    const age = Math.floor((Date.now() - m.user.createdTimestamp) / 86400000);
    sendLog(m.guild, 'raid', new EmbedBuilder()
      .setColor(age < 7 ? COLORS.raid : COLORS.ok)
      .setTitle('📥 Nouveau membre')
      .setDescription(`👤 ${who(m.user)}\n📅 Compte créé il y a **${age} jour(s)**${age < 7 ? '\n⚠️ Compte récent !' : ''}`)
      .setThumbnail(m.user.displayAvatarURL()));
  });

  client.on('guildMemberRemove', (m) =>
    sendLog(m.guild, 'raid', new EmbedBuilder()
      .setColor(COLORS.raid).setTitle('📤 Membre parti').setDescription(`👤 ${who(m.user)}`)));

  /* ---------- RANK / DERANK ---------- */
  client.on('guildMemberUpdate', async (o, n) => {
    if (o.partial) return;
    const added = n.roles.cache.filter((r) => !o.roles.cache.has(r.id));
    const removed = o.roles.cache.filter((r) => !n.roles.cache.has(r.id));
    if (added.size || removed.size) {
      const ex = await getExecutor(n.guild, AuditLogEvent.MemberRoleUpdate, n.id);
      const roles = (c) => c.map((r) => `<@&${r.id}>`).join(' ');
      if (added.size) sendLog(n.guild, 'rank', new EmbedBuilder().setColor(COLORS.ok)
        .setTitle('⬆️ Rank — Rôle ajouté')
        .setDescription(`🛠️ Par : ${who(ex?.user)}\n🎯 Concerné : ${who(n.user)}\n🏷️ Rôle(s) : ${roles(added)}`));
      if (removed.size) sendLog(n.guild, 'rank', new EmbedBuilder().setColor(COLORS.raid)
        .setTitle('⬇️ Derank — Rôle retiré')
        .setDescription(`🛠️ Par : ${who(ex?.user)}\n🎯 Concerné : ${who(n.user)}\n🏷️ Rôle(s) : ${roles(removed)}`));
    }

    if (o.communicationDisabledUntilTimestamp !== n.communicationDisabledUntilTimestamp) {
      const until = n.communicationDisabledUntilTimestamp;
      const on = until && until > Date.now();
      const ex = await getExecutor(n.guild, AuditLogEvent.MemberUpdate, n.id);
      sendLog(n.guild, 'mod', new EmbedBuilder().setColor(COLORS.mod)
        .setTitle(on ? '🔇 Membre timeout' : '🔊 Timeout retiré')
        .setDescription(`🛠️ Par : ${who(ex?.user)}\n🎯 Concerné : ${who(n.user)}${on ? `\n⏳ Jusqu'à <t:${Math.floor(until / 1000)}:R>` : ''}`));
    }
  });

  client.on('roleUpdate', async (o, n) => {
    if (o.permissions.bitfield === n.permissions.bitfield) return;
    const gained = o.permissions.missing(n.permissions);
    const lost = n.permissions.missing(o.permissions);
    const ex = await getExecutor(n.guild, AuditLogEvent.RoleUpdate, n.id);
    const e = new EmbedBuilder().setColor(COLORS.rank)
      .setTitle('🔐 Permissions de rôle modifiées')
      .setDescription(`🛠️ Par : ${who(ex?.user)}\n🏷️ Rôle : <@&${n.id}>`);
    if (gained.length) e.addFields({ name: '✅ Ajoutées', value: gained.map((p) => `\`${p}\``).join(', ') });
    if (lost.length) e.addFields({ name: '❌ Retirées', value: lost.map((p) => `\`${p}\``).join(', ') });
    sendLog(n.guild, 'rank', e);
  });

  /* ---------- MODÉRATION ---------- */
  client.on('guildBanAdd', async (b) => {
    const ex = await getExecutor(b.guild, AuditLogEvent.MemberBanAdd, b.user.id);
    sendLog(b.guild, 'mod', new EmbedBuilder().setColor(COLORS.raid).setTitle('🔨 Membre banni')
      .setDescription(`🛠️ Par : ${who(ex?.user)}\n🎯 Concerné : ${who(b.user)}\n📄 Raison : ${ex?.reason ?? 'Aucune'}`));
  });

  client.on('guildBanRemove', async (b) => {
    const ex = await getExecutor(b.guild, AuditLogEvent.MemberBanRemove, b.user.id);
    sendLog(b.guild, 'mod', new EmbedBuilder().setColor(COLORS.ok).setTitle('♻️ Membre débanni')
      .setDescription(`🛠️ Par : ${who(ex?.user)}\n🎯 Concerné : ${who(b.user)}`));
  });
};
