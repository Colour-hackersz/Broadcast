g comma-separated serial numbers. Exiting.'); ctx.session.broadcastFlow = null; return ctx.scene.leave(); }
    const txt = ctx.message.text.trim();
    if(txt === '/cancel'){ ctx.session.broadcastFlow = null; await ctx.reply('Cancelled broadcast setup.'); return ctx.scene.leave(); }
    const parts = txt.split(',').map(s=>parseInt(s.trim(),10)).filter(n=>!isNaN(n));
    if(parts.length===0){ await ctx.reply('No valid numbers detected. Send like 1,3'); return; }
    const bots = ctx.session.broadcastFlow?.bots;
    if(!bots){ await ctx.reply('Internal error. Please start over with /broadcast.'); ctx.session.broadcastFlow = null; return ctx.scene.leave(); }
    const selected = [];
    for(const n of parts){ if(n<1 || n>bots.length){ await ctx.reply(`Invalid serial number: ${n}. Must be between 1 and ${bots.length}.`); return; } if(!selected.includes(n-1)) selected.push(n-1); }
    let totUsers = 0;
    selected.forEach(idx => { const u = Array.isArray(bots[idx].users) ? bots[idx].users.length : 0; totUsers += u; });
    ctx.session.broadcastFlow.selectedSerials = selected;
    await ctx.reply(`Selected bots: ${selected.map(i=>i+1).join(', ')}\nTotal bots selected: ${selected.length}\nTotal users to message: ${totUsers}\n\nNow send the message URL (e.g., https://t.me/c/2553029499/18095) or /cancel.`);
    return ctx.scene.enter('collectUrlScene');
  } catch(e){
    ctx.session.broadcastFlow = null;
    await ctx.reply('Internal error. Abort.');
    return ctx.scene.leave();
  }
});

collectUrlScene.enter(ctx => ctx.reply('Send the message URL now (e.g., https://t.me/c/2553029499/18095).'));
collectUrlScene.on('message', async (ctx) => {
  try{
    if(!ctx.message || !ctx.message.text){ await ctx.reply('Send only the message URL as text. Exiting.'); ctx.session.broadcastFlow = null; return ctx.scene.leave(); }
    const txt = ctx.message.text.trim();
    if(txt === '/cancel'){ ctx.session.broadcastFlow = null; await ctx.reply('Cancelled broadcast setup.'); return ctx.scene.leave(); }
    const parsed = parseTgUrl(txt);
    if(!parsed){ await ctx.reply('Invalid URL format. Use https://t.me/c/<chat_id>/<message_id>. Try again or /cancel.'); return; }
    const isMember = await checkBotMembership(parsed.from_chat_id);
    if(!isMember){ await ctx.reply('Bot is not a member or lacks permissions in the source chat. Add it and try again or /cancel.'); return; }

    try{ await bot.telegram.forwardMessage(ctx.from.id, parsed.from_chat_id, parsed.message_id); }
    catch(err){
      let errorMsg = 'Failed to access the message. ';
      if(err.code === 403) errorMsg += 'Bot lacks permission to forward messages.';
      else if(err.code === 400) errorMsg += `Invalid chat ID or message ID, or message does not exist.`;
      else errorMsg += `Error: ${err.description || err.message}.`;
      await ctx.reply(errorMsg + ' Try another URL or /cancel.');
      return;
    }

    ctx.session.broadcastFlow.parsedFrom = parsed;
    const { groupId, selectedSerials, bots } = ctx.session.broadcastFlow;
    const selectedBots = selectedSerials.map(i => bots[i]);
    const totalSelectedUsers = selectedBots.reduce((acc,b)=>acc + (Array.isArray(b.users)?b.users.length:0),0);
    const keyboard = Markup.inlineKeyboard([ Markup.button.callback('Start Broadcast', `start_broadcast:${groupId}`) ]);
    await ctx.reply(`Message forwarded successfully. Confirm broadcast details:\nGroup ID: ${groupId}\nBots selected: ${selectedBots.length}\nTotal users: ${totalSelectedUsers}\nMessage URL: ${txt}\n\nPress "Start Broadcast" to proceed or /cancel to abort.`, keyboard);
    return ctx.scene.enter('confirmScene');
  } catch(e){
    ctx.session.broadcastFlow = null;
    await ctx.reply('Internal error. Abort.');
    return ctx.scene.leave();
  }
});

confirmScene.enter(ctx => {});
confirmScene.action(/start_broadcast:(\S+)/, async (ctx) => {
  try{
    const groupId = ctx.match[1];
    const initiatorId = ctx.from.id;
    const { bots, selectedSerials, parsedFrom } = ctx.session.broadcastFlow;
    if(runningByGroup.has(groupId)){ await ctx.reply(`A broadcast is already running for group id ${groupId}. Aborting.`); ctx.session.broadcastFlow = null; return ctx.scene.leave(); }
    if(runningByUser.has(initiatorId)){ await ctx.reply(`You already have a broadcast running. Finish or /kill it before starting another.`); ctx.session.broadcastFlow = null; return ctx.scene.leave(); }

    const selectedBots = selectedSerials.map(i => bots[i]);
    const totalSelectedUsers = selectedBots.reduce((acc,b)=>acc + (Array.isArray(b.users)?b.users.length:0),0);
    const broadcastInfo = {
      groupId,
      initiatorId,
      selectedBots,
      parsedFrom,
      stats: { totalBots: selectedBots.length, totalUsers: totalSelectedUsers, attempted:0, success:0, failed:0 },
      startTime: Date.now(),
      cancelled: false
    };

    runningByGroup.set(groupId, broadcastInfo);
    runningByUser.set(initiatorId, groupId);
    await ctx.reply(`Starting broadcast:\nGroup ID: ${groupId}\nBots selected: ${selectedBots.length}\nTotal users: ${totalSelectedUsers}\n\nYou can send /kill to stop the running broadcast. Use /status to check progress.`);
    runBroadcast(broadcastInfo).catch(err => {});
    ctx.session.broadcastFlow = null;
    return ctx.scene.leave();
  } catch(e){
    ctx.session.broadcastFlow = null;
    await ctx.reply('Internal error. Abort.');
    return ctx.scene.leave();
  }
});
confirmScene.on('message', async (ctx) => {
  if(ctx.message.text === '/cancel'){ ctx.session.broadcastFlow = null; await ctx.reply('Cancelled broadcast setup.'); return ctx.scene.leave(); }
  await ctx.reply('Please use the "Start Broadcast" button or /cancel.');
});

async function runBroadcast(binfo){
  const { groupId, initiatorId, selectedBots, parsedFrom } = binfo;
  const from_chat_id = parsedFrom.from_chat_id;
  const message_id = parsedFrom.message_id;
  try{
    for(let bi=0; bi<selectedBots.length; bi++){
      if(binfo.cancelled) break;
      const botObj = selectedBots[bi];
      const botToken = botObj.bot_token;
      const users = Array.isArray(botObj.users) ? botObj.users.slice() : [];
      const batches = chunkArray(users, BATCH_SIZE);
      for(let batchIndex=0; batchIndex<batches.length; batchIndex++){
        if(binfo.cancelled) break;
        const batch = batches[batchIndex];
        const promises = batch.map(async (userId) => {
          if(binfo.cancelled) return { ok:false, error:'cancelled' };
          binfo.stats.attempted++;
          const chatId = userId;
          const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/forwardMessage`;
          const payload = { chat_id: chatId, from_chat_id, message_id };
          try{
            const resp = await axiosPost(url, payload, { timeout: 20000 });
            if(resp && resp.data && resp.data.ok){ binfo.stats.success++; return { ok:true }; }
            binfo.stats.failed++; return { ok:false, error: resp && resp.data ? resp.data : 'unknown' };
          } catch(err){
            binfo.stats.failed++; return { ok:false, error: (err && err.message) ? err.message : String(err) };
          }
        });
        try{ await Promise.all(promises); } catch(err){}
        await sleep(BATCH_PAUSE_MS);
      }
    }
  } finally {
    const endTime = Date.now();
    const elapsedSec = Math.round((endTime - binfo.startTime)/1000);
    const summary =
      `Broadcast summary for group ${binfo.groupId}:\n` +
      `Total bots: ${binfo.stats.totalBots}\n` +
      `Total users targeted: ${binfo.stats.totalUsers}\n` +
      `Attempted: ${binfo.stats.attempted}\n` +
      `Success: ${binfo.stats.success}\n` +
      `Failed: ${binfo.stats.failed}\n` +
      `Time taken: ${elapsedSec} seconds\n` +
      (binfo.cancelled ? 'Status: CANCELLED' : 'Status: COMPLETED');
    try{ await bot.telegram.sendMessage(binfo.initiatorId, summary); } catch(e){}
    runningByGroup.delete(binfo.groupId);
    if(runningByUser.get(binfo.initiatorId) === binfo.groupId) runningByUser.delete(binfo.initiatorId);
  }
}

const stage = new Stage([broadcastScene, collectSerialsScene, collectUrlScene, confirmScene]);
bot.use(session());
bot.use(stage.middleware());

bot.start((ctx) => ctx.reply(`Welcome. Commands:\n/broadcast - start broadcast setup\n/kill - kill your running broadcast\n/status - show status of your running broadcast\n/cancel - cancel during setup`));
bot.command('broadcast', (ctx) => ctx.scene.enter('broadcastScene'));
bot.command('cancel', async (ctx) => {
  try{ if(ctx.scene && typeof ctx.scene.leave === 'function'){ await ctx.scene.leave(); ctx.session.broadcastFlow = null; return ctx.reply('Cancelled.'); } return ctx.reply('Nothing to cancel.'); }
  catch(e){ return ctx.reply('Cancelled (with error).'); }
});
bot.command('kill', (ctx) => {
  const uid = ctx.from.id;
  const groupId = runningByUser.get(uid);
  if(!groupId) return ctx.reply('You have no running broadcast.');
  const binfo = runningByGroup.get(groupId);
  if(!binfo){ runningByUser.delete(uid); return ctx.reply('No running broadcast found (cleaned up).'); }
  binfo.cancelled = true;
  ctx.reply(`Killed broadcast for group ${groupId}. Waiting for ongoing operations to stop...`);
});
bot.command('status', (ctx) => {
  const uid = ctx.from.id;
  const groupId = runningByUser.get(uid);
  if(!groupId) return ctx.reply('You have no running broadcast.');
  const binfo = runningByGroup.get(groupId);
  if(!binfo){ runningByUser.delete(uid); return ctx.reply('No running broadcast found (cleaned up).'); }
  const elapsedSec = Math.round((Date.now() - binfo.startTime)/1000);
  const text =
    `Broadcast status for group ${groupId} (initiated by you):\n` +
    `Total bots: ${binfo.stats.totalBots}\n` +
    `Total users targeted: ${binfo.stats.totalUsers}\n` +
    `Attempted: ${binfo.stats.attempted}\n` +
    `Success: ${binfo.stats.success}\n` +
    `Failed: ${binfo.stats.failed}\n` +
    `Time running: ${elapsedSec} seconds`;
  ctx.reply(text);
});

bot.catch((err, ctx) => {});

bot.launch().then(() => {}).catch(err => {});
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
// ─────────────────────────────────────────────
// IMPORTS & SETUP
// ─────────────────────────────────────────────
const { Telegraf, Markup, session, Scenes } = require('telegraf');
const axios = require('axios');
const { BaseScene, Stage } = Scenes;
const express = require("express");

// TELEGRAM BOT TOKEN
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8598147501:AAGyMB0vekD0u7M-ZsKXFults_JMB726UWc";
if (!BOT_TOKEN) {
  console.error("BOT TOKEN MISSING");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ─────────────────────────────────────────────
// GLOBAL STATE
// ─────────────────────────────────────────────
const runningByGroup = new Map();
const runningByUser = new Map();

const GLOBAL_MAX_CONCURRENCY = 50;
const BATCH_SIZE = 29;
const BATCH_PAUSE_MS = 500;

// ─────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size)
    out.push(arr.slice(i, i + size));
  return out;
}

function parseTgUrl(url) {
  const m = String(url).trim().match(/(?:https?:\/\/)?t\.me\/c\/(\d+)\/(\d+)/i);
  if (!m) return null;
  return { from_chat_id: '-100' + m[1], message_id: parseInt(m[2]) };
}

function splitTelegramMessage(text, maxLen = 4000) {
  if (!text) return [''];
  if (text.length <= maxLen) return [text];
  const lines = text.split('\n');
  const parts = [];
  let cur = '';
  for (const line of lines) {
    if ((cur + '\n' + line).length > maxLen) {
      if (cur.length) parts.push(cur);
      if (line.length > maxLen) {
        for (let i = 0; i < line.length; i += maxLen)
          parts.push(line.slice(i, i + maxLen));
        cur = '';
      } else cur = line;
    } else cur = cur ? (cur + '\n' + line) : line;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

// ─────────────────────────────────────────────
// SEMAPHORE FOR GLOBAL RATE LIMIT
// ─────────────────────────────────────────────
class Semaphore {
  constructor(max) { this.max = max; this.current = 0; this.queue = []; }
  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return () => this.release();
    }
    return await new Promise(resolve => this.queue.push(resolve));
  }
  release() {
    this.current--;
    if (this.queue.length > 0) {
      this.current++;
      const next = this.queue.shift();
      next(() => this.release());
    }
  }
}
const globalSemaphore = new Semaphore(GLOBAL_MAX_CONCURRENCY);

async function axiosPost(url, payload, opts = {}) {
  const release = await globalSemaphore.acquire();
  try {
    const resp = await axios.post(url, payload, { timeout: opts.timeout || 20000 });
    release();
    return resp;
  } catch (err) {
    release();
    throw err;
  }
}

async function checkBotMembership(chatId) {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`;
    const payload = { chat_id: chatId, user_id: bot.botInfo.id };
    const resp = await axiosPost(url, payload);
    return resp.data.ok &&
      ['member', 'administrator', 'creator'].includes(resp.data.result.status);
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
// SCENES
// ─────────────────────────────────────────────

const broadcastScene = new BaseScene('broadcastScene');
const collectSerialsScene = new BaseScene('collectSerialsScene');
const collectUrlScene = new BaseScene('collectUrlScene');
const confirmScene = new BaseScene('confirmScene');

//──────────────────────────────────────────────
// BROADCAST SCENE
//──────────────────────────────────────────────

broadcastScene.enter(ctx =>
  ctx.reply('Send group id (text only). Send /cancel to stop.')
);

broadcastScene.on('message', async (ctx) => {
  try {
    if (!ctx.message.text) {
      await ctx.reply('Text only. Exiting.');
      return ctx.scene.leave();
    }

    const groupKey = ctx.message.text.trim();
    const fromId = ctx.from.id;

    if (runningByGroup.has(groupKey))
      return ctx.reply(`A broadcast is already running for ${groupKey}.`);

    if (runningByUser.has(fromId))
      return ctx.reply(`You already have a running broadcast.`);

    await ctx.reply(`Fetching bots for group id ${groupKey}...`);

    let resp;
    try {
      resp = await axios.get(
        `https://broadcast.upayme.link/get-all.php?group_id=${encodeURIComponent(groupKey)}`,
        { timeout: 15000 }
      );
    } catch {
      await ctx.reply('API error. Try again.');
      return ctx.scene.leave();
    }

    const data = resp.data;
    if (!data.success || !Array.isArray(data.bots)) {
      await ctx.reply('API returned no bots.');
      return ctx.scene.leave();
    }

    const bots = data.bots;
    if (!bots.length) {
      await ctx.reply('No bots found.');
      return ctx.scene.leave();
    }

    let lines = [];
    let totalUsers = 0;
    bots.forEach((b, i) => {
      const count = Array.isArray(b.users) ? b.users.length : 0;
      totalUsers += count;
      lines.push(`${i + 1}. ${b.name} - ${count}`);
    });
    lines.push('', `Total bots: ${bots.length}`, `Total users: ${totalUsers}`);
    lines.push('', 'Send serials now (1,3,7...)');

    for (const p of splitTelegramMessage(lines.join('\n')))
      await ctx.reply(p);

    ctx.session.broadcastFlow = { groupId: groupKey, bots, selectedSerials: null, fromUserId: fromId };

    return ctx.scene.enter('collectSerialsScene');
  } catch (e) {
    await ctx.reply('Error. Abort.');
    ctx.scene.leave();
  }
});

//──────────────────────────────────────────────
// SELECT SERIALS
//──────────────────────────────────────────────

collectSerialsScene.enter(ctx => {
  const groupId = ctx.session.broadcastFlow.groupId;
  return ctx.reply(
    'Send serial numbers (e.g., 1,3)\n\nOr use web selector:',
    Markup.inlineKeyboard([
      Markup.button.url(
        'Select bots (web)',
        'https://broadcast.upayme.link/bot-select.html?group_id=' + encodeURIComponent(groupId)
      )
    ])
  );
});

collectSerialsScene.on('message', async (ctx) => {
  try {
    const txt = ctx.message.text.trim();
    if (txt === '/cancel') {
      ctx.session.broadcastFlow = null;
      return ctx.reply('Cancelled.');
    }

    const nums = txt
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n));

    if (!nums.length)
      return ctx.reply('Invalid format. Send like: 1,3');

    const bots = ctx.session.broadcastFlow.bots;
    const selected = [];

    for (const n of nums) {
      if (n < 1 || n > bots.length)
        return ctx.reply(`Invalid number: ${n}`);
      if (!selected.includes(n - 1))
        selected.push(n - 1);
    }

    ctx.session.broadcastFlow.selectedSerials = selected;

    const selectedBots = selected.map(i => bots[i]);
    const totalUsers = selectedBots.reduce((a, b) => a + (b.users?.length || 0), 0);

    await ctx.reply(
      `Selected bots: ${selected.map(i => i + 1).join(', ')}\n` +
      `Total users: ${totalUsers}\n\n` +
      `Now send message URL (like https://t.me/c/xxx/yyy)`
    );

    return ctx.scene.enter('collectUrlScene');
  } catch {
    ctx.session.broadcastFlow = null;
    ctx.reply('Error.');
    ctx.scene.leave();
  }
});

//──────────────────────────────────────────────
// COLLECT URL
//──────────────────────────────────────────────

collectUrlScene.on('message', async (ctx) => {
  try {
    const txt = ctx.message.text.trim();
    if (txt === '/cancel') return ctx.reply('Cancelled.');

    const parsed = parseTgUrl(txt);
    if (!parsed) return ctx.reply('Invalid URL format.');

    // Check bot has access to the source chat
    const isMember = await checkBotMembership(parsed.from_chat_id);
    if (!isMember) return ctx.reply('Bot is not a member of that chat.');

    // Try forwarding
    try {
      await bot.telegram.forwardMessage(ctx.from.id, parsed.from_chat_id, parsed.message_id);
    } catch (err) {
      return ctx.reply('Cannot forward this message. Wrong chat/message.');
    }

    ctx.session.broadcastFlow.parsedFrom = parsed;

    const { selectedSerials, bots } = ctx.session.broadcastFlow;
    const selectedBots = selectedSerials.map(i => bots[i]);
    const totalUsers = selectedBots.reduce((a, b) => a + (b.users?.length || 0), 0);

    return ctx.reply(
      `Message OK.\nBots: ${selectedBots.length}\nUsers: ${totalUsers}\n\nStart?`,
      Markup.inlineKeyboard([
        Markup.button.callback('Start Broadcast', `start_broadcast`)
      ])
    );
  } catch {
    ctx.reply('Error.');
    ctx.scene.leave();
  }
});

//──────────────────────────────────────────────
// CONFIRM START
//──────────────────────────────────────────────

confirmScene.action('start_broadcast', async (ctx) => {
  const flow = ctx.session.broadcastFlow;
  if (!flow) return ctx.reply('Session expired.');

  const { groupId, fromUserId, selectedSerials, bots, parsedFrom } = flow;

  if (runningByGroup.has(groupId))
    return ctx.reply('A broadcast already running for this group.');

  if (runningByUser.has(fromUserId))
    return ctx.reply('You are already broadcasting.');

  const selectedBots = selectedSerials.map(i => bots[i]);
  const totalUsers = selectedBots.reduce((a, b) => a + (b.users?.length || 0), 0);

  const binfo = {
    groupId,
    initiatorId: fromUserId,
    selectedBots,
    parsedFrom,
    stats: { totalBots: selectedBots.length, totalUsers, attempted: 0, success: 0, failed: 0 },
    startTime: Date.now(),
    cancelled: false
  };

  runningByGroup.set(groupId, binfo);
  runningByUser.set(fromUserId, groupId);

  ctx.reply(`Broadcast started.\nUsers: ${totalUsers}\nUse /kill to stop.`);

  runBroadcast(binfo).catch(console.error);

  ctx.session.broadcastFlow = null;
  ctx.scene.leave();
});

//──────────────────────────────────────────────
// BROADCAST LOOP
//──────────────────────────────────────────────

async function runBroadcast(binfo) {
  const { selectedBots, parsedFrom } = binfo;

  try {
    for (const botObj of selectedBots) {
      if (binfo.cancelled) break;

      const botToken = botObj.bot_token;
      const users = botObj.users || [];
      const batches = chunkArray(users, BATCH_SIZE);

      for (const batch of batches) {
        if (binfo.cancelled) break;

        const tasks = batch.map(async (uid) => {
          binfo.stats.attempted++;

          const url = `https://api.telegram.org/bot${botToken}/forwardMessage`;
          const payload = {
            chat_id: uid,
            from_chat_id: parsedFrom.from_chat_id,
            message_id: parsedFrom.message_id
          };

          try {
            const resp = await axiosPost(url, payload);
            if (resp.data.ok) binfo.stats.success++;
            else binfo.stats.failed++;
          } catch {
            binfo.stats.failed++;
          }
        });

        await Promise.all(tasks);
        await sleep(BATCH_PAUSE_MS);
      }
    }
  } finally {
    const t = Date.now() - binfo.startTime;

    const summary =
      `Broadcast finished.\n` +
      `Bots: ${binfo.stats.totalBots}\n` +
      `Users: ${binfo.stats.totalUsers}\n` +
      `Attempted: ${binfo.stats.attempted}\n` +
      `Success: ${binfo.stats.success}\n` +
      `Failed: ${binfo.stats.failed}\n` +
      `Time: ${Math.floor(t / 1000)} sec\n` +
      (binfo.cancelled ? `Status: CANCELLED` : `Status: COMPLETED`);

    bot.telegram.sendMessage(binfo.initiatorId, summary).catch(() => {});

    runningByGroup.delete(binfo.groupId);
    runningByUser.delete(binfo.initiatorId);
  }
}

//──────────────────────────────────────────────
// BOT COMMANDS
//──────────────────────────────────────────────

const stage = new Stage([broadcastScene, collectSerialsScene, collectUrlScene, confirmScene]);
bot.use(session());
bot.use(stage.middleware());

bot.start((ctx) =>
  ctx.reply(`Welcome.\nCommands:\n/broadcast\n/status\n/kill\n/cancel`)
);

bot.command('broadcast', (ctx) => ctx.scene.enter('broadcastScene'));

bot.command('cancel', async (ctx) => {
  try {
    await ctx.scene.leave();
    ctx.session.broadcastFlow = null;
    ctx.reply('Cancelled.');
  } catch {
    ctx.reply('Error.');
  }
});

bot.command('kill', (ctx) => {
  const uid = ctx.from.id;
  const groupId = runningByUser.get(uid);
  if (!groupId) return ctx.reply('No broadcast running.');

  const run = runningByGroup.get(groupId);
  if (!run) return ctx.reply('Already stopped.');

  run.cancelled = true;
  ctx.reply('Stopping broadcast...');
});

bot.command('status', (ctx) => {
  const uid = ctx.from.id;
  const groupId = runningByUser.get(uid);
  if (!groupId) return ctx.reply('No broadcast running.');

  const run = runningByGroup.get(groupId);
  if (!run) return ctx.reply('No active broadcast found.');

  const elapsed = Math.floor((Date.now() - run.startTime) / 1000);

  ctx.reply(
    `Status:\n` +
    `Bots: ${run.stats.totalBots}\n` +
    `Users: ${run.stats.totalUsers}\n` +
    `Attempted: ${run.stats.attempted}\n` +
    `Success: ${run.stats.success}\n` +
    `Failed: ${run.stats.failed}\n` +
    `Elapsed: ${elapsed} sec`
  );
});

//──────────────────────────────────────────────
// ERROR HANDLERS
//──────────────────────────────────────────────

bot.catch((err) => {
  console.error("BOT ERROR:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED PROMISE REJECTION:", err);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

//──────────────────────────────────────────────
// START EXPRESS KEEP-ALIVE SERVER (REQUIRED FOR RENDER)
//──────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Broadcast Bot Running ✔");
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

//──────────────────────────────────────────────
// LAUNCH TELEGRAM BOT
//──────────────────────────────────────────────

bot.launch().then(() => {
  console.log("Bot started ✔");
});
