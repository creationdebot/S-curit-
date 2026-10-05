// Bot de sécurité (anti-nuke) : à héberger séparément de ton bot principal.
// Commandes (propriétaire du serveur + whitelist) :
//   &secur on | off | check
//   &secur wl add|remove @personne|ID   &secur wl list
//   &add @role              -> définit le rôle des volontaires + poste le bouton pour le prendre
//   &dm @role ton message   -> envoie un MP aux volontaires (membres ayant ce rôle)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, AuditLogEvent, EmbedBuilder, PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');

const PREFIX = process.env.PREFIX || '&';
const CONFIG_PATH = path.join(__dirname, 'secur.json');
const LOG_CHANNEL_NAME = 'moderation-logs'; // salon de logs (optionnel)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.on('unhandledRejection', (e) => console.error('Erreur non gérée :', e));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ---------- Config ----------
let cache = {};
if (fs.existsSync(CONFIG_PATH)) {
  try { cache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
}
function getCfg(guildId) {
  const c = cache[guildId] || {};
  return { enabled: !!c.enabled, whitelist: c.whitelist || [], dmRoleId: c.dmRoleId || null };
}
function setCfg(guildId, cfg) {
  cache[guildId] = cfg;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cache, null, 2));
}
const isEnabled = (guild) => getCfg(guild.id).enabled;

// Propriétaire, ce bot et la whitelist ne sont jamais punis
function isSafe(guild, userId) {
  if (!userId) return false;
  if (userId === guild.ownerId) return true;
  if (userId === client.user.id) return true;
  return getCfg(guild.id).whitelist.includes(userId);
}

// ---------- Utilitaires ----------
async function log(guild, text) {
  console.log(`[SECUR] ${text}`);
  const channel = guild.channels.cache.find(
    (c) => c.name === LOG_CHANNEL_NAME && c.isTextBased()
  );
  if (channel) channel.send(`🚨 ${text}`).catch(() => {});
}

async function findExecutor(guild, type, targetId, predicate, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const logs = await guild.fetchAuditLogs({ type, limit: 8 }).catch(() => null);
    const entry = logs?.entries.find(
      (e) =>
        (!targetId || e.target?.id === targetId) &&
        Date.now() - e.createdTimestamp < 15000 &&
        (!predicate || predicate(e))
    );
    if (entry) return entry;
    await sleep(700);
  }
  console.log(
    `[SECUR] Aucun auteur trouvé dans les logs pour "${AuditLogEvent[type] ?? type}" ` +
    `(permission "Voir les logs du serveur" manquante ?)`
  );
  return null;
}

// Retire tous les rôles retirables de la personne
async function derank(guild, userId, reason) {
  if (!userId || userId === guild.ownerId || userId === client.user.id) return;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  const myTop = guild.members.me.roles.highest.position;
  const removable = member.roles.cache.filter(
    (r) => r.id !== guild.id && !r.managed && r.position < myTop
  );
  const stuck = member.roles.cache.filter(
    (r) => r.id !== guild.id && !r.managed && r.position >= myTop
  );

  if (removable.size) {
    await member.roles.remove(removable, `Sécurité : ${reason}`).catch((e) =>
      console.error('Derank impossible :', e.message)
    );
  }

  let text = `**${member.user.tag}** a été derank : ${reason}`;
  if (stuck.size) {
    text += `\n⚠️ Rôles impossibles à retirer (au-dessus du bot) : ${stuck.map((r) => r.name).join(', ')}`;
  }
  await log(guild, text);
}

// ---------- Démarrage ----------
client.once('ready', async () => {
  console.log(`Bot de sécurité connecté : ${client.user.tag}`);
  client.user.setPresence({ activities: [{ name: `${PREFIX}secur` }], status: 'online' });
  // On charge les membres pour bien comparer les rôles avant/après
  for (const guild of client.guilds.cache.values()) {
    guild.members.fetch().catch(() => {});
  }
});

// ---------- 1) Rôles donnés (à soi ou à quelqu'un d'autre) ----------
const handledEntries = new Set();
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  const guild = newMember.guild;
  if (!isEnabled(guild)) return;

  const hasOld = !!oldMember?.roles?.cache && !oldMember.partial;
  let added = null;
  if (hasOld) {
    added = newMember.roles.cache.filter((r) => !oldMember.roles.cache.has(r.id) && !r.managed);
    if (added.size === 0) return;
  }

  const entry = await findExecutor(
    guild,
    AuditLogEvent.MemberRoleUpdate,
    newMember.id,
    (e) =>
      !handledEntries.has(e.id) &&
      e.changes?.some((c) => c.key === '$add' && c.new?.some((r) => !added || added.has(r.id))),
    hasOld ? 4 : 2
  );
  if (!entry) return;

  if (handledEntries.size > 200) handledEntries.clear();
  handledEntries.add(entry.id);
  if (isSafe(guild, entry.executorId)) return;

  if (!added) {
    const ids = entry.changes
      .filter((c) => c.key === '$add')
      .flatMap((c) => (c.new || []).map((r) => r.id));
    added = newMember.roles.cache.filter((r) => ids.includes(r.id) && !r.managed);
  }
  if (added.size) {
    await newMember.roles.remove(added, 'Sécurité : attribution de rôle non autorisée').catch(() => {});
  }
  const self = entry.executorId === newMember.id ? "s'est attribué" : `a donné à ${newMember.user.tag}`;
  await derank(guild, entry.executorId, `${self} le(s) rôle(s) ${added.map((r) => r.name).join(', ')}`);
});

// ---------- 2) @everyone / @here ----------
async function checkEveryone(message) {
  if (!isEnabled(message.guild)) return;
  if (isSafe(message.guild, message.author.id)) return;
  if (message.mentions.everyone || /@(everyone|here)/i.test(message.content)) {
    await message.delete().catch(() => {});
    await derank(message.guild, message.author.id, 'a utilisé @everyone / @here');
  }
}

// ---------- 3) Suppression de salon (recréé) ----------
client.on('channelDelete', async (channel) => {
  const guild = channel.guild;
  if (!guild || !isEnabled(guild)) return;

  const entry = await findExecutor(guild, AuditLogEvent.ChannelDelete, channel.id);
  if (!entry || isSafe(guild, entry.executorId)) return;

  try {
    const restored = await channel.clone({ reason: 'Sécurité : salon restauré' });
    await restored.setPosition(channel.rawPosition).catch(() => {});
  } catch (e) {
    console.error('Restauration du salon impossible :', e.message);
  }
  await derank(guild, entry.executorId, `a supprimé le salon #${channel.name}`);
});

// ---------- 4) Création de salon (supprimé) ----------
client.on('channelCreate', async (channel) => {
  const guild = channel.guild;
  if (!guild || !isEnabled(guild)) return;

  const entry = await findExecutor(guild, AuditLogEvent.ChannelCreate, channel.id);
  if (!entry || isSafe(guild, entry.executorId)) return;

  await channel.delete('Sécurité : création de salon non autorisée').catch(() => {});
  await derank(guild, entry.executorId, `a créé le salon #${channel.name}`);
});

// ---------- 5) Permissions d'un rôle (restaurées) ----------
client.on('roleUpdate', async (oldRole, newRole) => {
  const guild = newRole.guild;
  if (!isEnabled(guild) || newRole.managed) return;
  if (oldRole.permissions.equals(newRole.permissions)) return;

  const entry = await findExecutor(guild, AuditLogEvent.RoleUpdate, newRole.id);
  if (!entry || isSafe(guild, entry.executorId)) return;

  await newRole.setPermissions(oldRole.permissions, 'Sécurité : permissions restaurées').catch(() => {});
  await derank(guild, entry.executorId, `a modifié les permissions du rôle ${newRole.name}`);
});

// ---------- 6) Ajout d'un bot (expulsé) ----------
client.on('guildMemberAdd', async (member) => {
  const guild = member.guild;
  if (!member.user.bot || !isEnabled(guild)) return;
  if (isSafe(guild, member.id)) return; // bot whitelisté

  const entry = await findExecutor(guild, AuditLogEvent.BotAdd, member.id);
  if (entry && isSafe(guild, entry.executorId)) return;

  await member.kick('Sécurité : ajout de bot non autorisé').catch((e) =>
    console.error('Expulsion du bot impossible :', e.message)
  );
  if (entry) {
    await derank(guild, entry.executorId, `a ajouté le bot ${member.user.tag}`);
  } else {
    await log(guild, `Le bot **${member.user.tag}** a été expulsé (ajout non autorisé).`);
  }
});

// ---------- 7) Photo, bannière, nom, description, invite perso ----------
client.on('guildUpdate', async (oldG, newG) => {
  if (!isEnabled(newG)) return;

  const n = (v) => v || null;
  const changed = [];
  if (n(oldG.icon) !== n(newG.icon)) changed.push('icon');
  if (n(oldG.banner) !== n(newG.banner)) changed.push('banner');
  if (n(oldG.name) !== n(newG.name)) changed.push('name');
  if (n(oldG.description) !== n(newG.description)) changed.push('description');
  if (n(oldG.vanityURLCode) !== n(newG.vanityURLCode)) changed.push('vanity');
  if (changed.length === 0) return;

  const entry = await findExecutor(newG, AuditLogEvent.GuildUpdate, newG.id);
  if (!entry || isSafe(newG, entry.executorId)) return;

  const tryRevert = (p) => p.catch((e) => console.error('Restauration impossible :', e.message));
  if (changed.includes('icon')) await tryRevert(newG.setIcon(oldG.iconURL({ size: 4096 })));
  if (changed.includes('banner')) await tryRevert(newG.setBanner(oldG.bannerURL({ size: 4096 })));
  if (changed.includes('name')) await tryRevert(newG.setName(oldG.name));
  if (changed.includes('description')) await tryRevert(newG.setDescription(oldG.description));

  let reason = `a modifié le serveur (${changed.join(', ')})`;
  if (changed.includes('vanity')) {
    reason += ` — l'invite perso (${oldG.vanityURLCode || 'aucune'}) ne peut pas être restaurée par un bot`;
  }
  await derank(newG, entry.executorId, reason);
});

// ---------- MP aux volontaires (opt-in) ----------
const dmRunning = new Set();
const DM_DELAY = 2000; // 2 s entre chaque MP pour éviter le spam

async function handleDmCommands(message, cmd, args) {
  const guild = message.guild;
  const cfg = getCfg(guild.id);

  const allowed = message.author.id === guild.ownerId || cfg.whitelist.includes(message.author.id);
  if (!allowed) {
    return message.reply('❌ Seuls le propriétaire du serveur et les personnes whitelistées peuvent utiliser cette commande.');
  }

  // &add @role : définit le rôle volontaire + poste le bouton
  if (cmd === 'add') {
    const role = message.mentions.roles.first() || guild.roles.cache.get(args[0]);
    if (!role) return message.reply(`Utilisation : \`${PREFIX}add @role\``);
    if (role.id === guild.id || role.managed) return message.reply('❌ Ce rôle ne peut pas être utilisé.');
    if (role.position >= guild.members.me.roles.highest.position) {
      return message.reply('⚠️ Le rôle du bot doit être **au-dessus** de ce rôle dans la liste des rôles.');
    }

    cfg.dmRoleId = role.id;
    setCfg(guild.id, cfg);

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('la verif stp bg')
      .setDescription(
        `Appuie sur le bouton pour etre verif ${role} \n` +
        'est oui il faut te verif.'
      );
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('dm_toggle').setLabel('appuie wlh t verif').setStyle(ButtonStyle.Primary)
    );
    await message.channel.send({ embeds: [embed], components: [row] });
    await message.delete().catch(() => {});
    return;
  }

  // &dm @role message
  const role = message.mentions.roles.first();
  if (!role) return message.reply(`Utilisation : \`${PREFIX}dm @role ton message\``);

  if (!cfg.dmRoleId) {
    return message.reply(`❌ Configure d'abord le rôle des volontaires avec \`${PREFIX}add @role\`.`);
  }
  if (role.id !== cfg.dmRoleId) {
    return message.reply(`❌ Tu peux envoyer des MP **uniquement** au rôle des volontaires : <@&${cfg.dmRoleId}>.`);
  }

  const text = message.content.slice(PREFIX.length + 'dm'.length).replace(/<@&\d+>/, '').trim();
  if (!text) return message.reply(`Utilisation : \`${PREFIX}dm @role ton message\``);
  if (text.length > 1800) return message.reply('❌ Message trop long (1800 caractères maximum).');
  if (dmRunning.has(guild.id)) return message.reply('⏳ Un envoi est déjà en cours.');

  await guild.members.fetch().catch(() => {});
  const targets = role.members.filter((m) => !m.user.bot);
  if (targets.size === 0) return message.reply("Personne n'a ce rôle pour le moment.");

  dmRunning.add(guild.id);
  const minutes = Math.max(1, Math.ceil((targets.size * DM_DELAY) / 60000));
  const status = await message.reply(`📨 Envoi à **${targets.size}** membre(s)... (environ ${minutes} min)`);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({ name: guild.name, iconURL: guild.iconURL() || undefined })
    .setTitle('📢 Annonce')
    .setDescription(text)
    .setFooter({ text: `Tu reçois ce message car tu as pris le rôle ${role.name}. mes /lanewkeh en statu stp bg });

  let sent = 0;
  let failed = 0;
  let tooFast = 0;
  let aborted = false;

  try {
    for (const [, member] of targets) {
      try {
        await member.send({ embeds: [embed] });
        sent++;
        tooFast = 0;
      } catch (e) {
        failed++; // MP fermés ou bloqués
        if (e.code === 40003) { // Discord trouve qu'on envoie trop vite
          tooFast++;
          if (tooFast >= 3) { aborted = true; break; }
          await sleep(30000);
        }
      }
      await sleep(DM_DELAY);
    }
  } finally {
    dmRunning.delete(guild.id);
  }

  const result =
    `${aborted ? '⚠️ Envoi **arrêté** (Discord limite les MP). ' : '✅ Envoi terminé. '}` +
    `Reçus : **${sent}** · Échecs (MP fermés) : **${failed}**`;
  await status.edit(result).catch(() => message.channel.send(result).catch(() => {}));
}

// Bouton : prendre / retirer le rôle volontaire
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton() || interaction.customId !== 'dm_toggle') return;

  const cfg = getCfg(interaction.guild.id);
  const role = cfg.dmRoleId && interaction.guild.roles.cache.get(cfg.dmRoleId);
  if (!role) {
    return interaction.reply({ content: "❌ Ce système n'est plus configuré.", flags: MessageFlags.Ephemeral });
  }

  try {
    if (interaction.member.roles.cache.has(role.id)) {
      await interaction.member.roles.remove(role);
      return interaction.reply({ content: '🔕 Tu ne recevras plus les annonces en MP.', flags: MessageFlags.Ephemeral });
    }
    await interaction.member.roles.add(role);
    return interaction.reply({ content: '🔔 Tu recevras désormais les annonces en MP.', flags: MessageFlags.Ephemeral });
  } catch (e) {
    console.error(e);
    return interaction.reply({ content: '❌ Impossible de modifier ton rôle pour le moment.', flags: MessageFlags.Ephemeral });
  }
});

// ---------- Commandes ----------
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;

  await checkEveryone(message);

  if (!message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();

  if (cmd === 'add' || cmd === 'dm') return handleDmCommands(message, cmd, args);
  if (cmd !== 'secur') return;

  const guild = message.guild;
  const cfg = getCfg(guild.id);

  const allowed = message.author.id === guild.ownerId || cfg.whitelist.includes(message.author.id);
  if (!allowed) {
    return message.reply('❌ Seuls le propriétaire du serveur et les personnes whitelistées peuvent utiliser cette commande.');
  }

  const sub = args[0]?.toLowerCase();

  if (sub === 'on' || sub === 'off') {
    cfg.enabled = sub === 'on';
    setCfg(guild.id, cfg);
    return message.reply(cfg.enabled ? '🔒 Sécurité **activée**.' : '🔓 Sécurité **désactivée**.');
  }

  if (sub === 'wl' || sub === 'whitelist') {
    const action = args[1]?.toLowerCase();

    if (action === 'list') {
      const list = cfg.whitelist.length ? cfg.whitelist.map((id) => `<@${id}>`).join('\n') : 'Personne (à part le propriétaire).';
      return message.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('Whitelist').setDescription(list)] });
    }

    if (action === 'add' || action === 'remove') {
      const targetId =
        message.mentions.users.first()?.id || (/^\d{17,20}$/.test(args[2] || '') ? args[2] : null);
      if (!targetId) return message.reply(`Utilisation : \`${PREFIX}secur wl add @personne\` (ou son ID, pour un bot)`);

      if (action === 'add') {
        if (!cfg.whitelist.includes(targetId)) cfg.whitelist.push(targetId);
      } else {
        cfg.whitelist = cfg.whitelist.filter((id) => id !== targetId);
      }
      setCfg(guild.id, cfg);
      return message.reply(action === 'add' ? `✅ <@${targetId}> ajouté à la whitelist.` : `✅ <@${targetId}> retiré de la whitelist.`);
    }

    return message.reply(`Utilisation : \`${PREFIX}secur wl add|remove @personne\` ou \`${PREFIX}secur wl list\``);
  }

  if (sub === 'check' || sub === 'test') {
    const me = guild.members.me;
    const P = PermissionFlagsBits;
    const ok = (b) => (b ? '✅' : '❌');
    const perm = (flag) => ok(me.permissions.has(flag));
    const myTop = me.roles.highest.position;
    const above = guild.roles.cache.filter((r) => r.id !== guild.id && r.position > myTop).size;
    const auditOk = await guild.fetchAuditLogs({ limit: 1 }).then(() => true).catch(() => false);

    const lines = [
      `${ok(cfg.enabled)} Sécurité activée (\`${PREFIX}secur on\`)`,
      `${perm(P.ViewAuditLog)} Permission : voir les logs du serveur`,
      `${ok(auditOk)} Lecture des logs d'audit`,
      `${perm(P.ManageRoles)} Permission : gérer les rôles`,
      `${perm(P.ManageChannels)} Permission : gérer les salons`,
      `${perm(P.ManageGuild)} Permission : gérer le serveur`,
      `${perm(P.KickMembers)} Permission : expulser des membres`,
      `${ok(above === 0)} Rôle du bot tout en haut` + (above ? ` (${above} rôle(s) au-dessus)` : ''),
      `ℹ️ Whitelist : ${cfg.whitelist.length} personne(s), jamais punies`,
    ];
    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('Diagnostic de la sécurité')
          .setDescription(lines.join('\n'))
          .setFooter({ text: "Teste avec un compte qui n'est ni propriétaire ni whitelisté." }),
      ],
    });
  }

  // Statut
  const embed = new EmbedBuilder()
    .setColor(cfg.enabled ? 0x57f287 : 0xed4245)
    .setTitle(`Sécurité : ${cfg.enabled ? '🔒 ACTIVÉE' : '🔓 DÉSACTIVÉE'}`)
    .setDescription(
      'Protégé (même contre les admins) :\n' +
      '• Se donner / donner des rôles\n' +
      '• @everyone et @here\n' +
      '• Supprimer / créer des salons\n' +
      "• Modifier les permissions d'un rôle\n" +
      '• Ajouter un bot\n' +
      "• Photo, bannière, nom, description et invite perso du serveur\n\n" +
      `\`${PREFIX}secur on\` / \`${PREFIX}secur off\`\n` +
      `\`${PREFIX}secur wl add|remove @personne\`\n` +
      `\`${PREFIX}secur wl list\`\n` +
      `\`${PREFIX}secur check\` (diagnostic)\n\n` +
      `\`${PREFIX}add @role\` : rôle des volontaires pour les MP\n` +
      `\`${PREFIX}dm @role message\` : envoyer un MP aux volontaires`
    )
    .setFooter({ text: `Whitelist : ${cfg.whitelist.length} personne(s)` });
  return message.reply({ embeds: [embed] });
});

client.login(process.env.SECUR_TOKEN);
