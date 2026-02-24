// server.js — MIMIgraf backend
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

const DB_DIR = path.join(__dirname, 'db');
const SESS_DIR = path.join(__dirname, 'sessions');
const PUB_DIR = path.join(__dirname, 'public');

[DB_DIR, SESS_DIR, path.join(PUB_DIR, 'uploads')].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── DB helpers ──
const dbPath = n => path.join(DB_DIR, `${n}.json`);
const readDb = (n, def) => { try { return JSON.parse(fs.readFileSync(dbPath(n), 'utf8')); } catch { return def !== undefined ? def : (Array.isArray(def) ? [] : {}); } };
const writeDb = (n, d) => fs.writeFileSync(dbPath(n), JSON.stringify(d, null, 2));

// Init DBs
if (!fs.existsSync(dbPath('users'))) writeDb('users', []);
if (!fs.existsSync(dbPath('chats'))) writeDb('chats', {});   // { chatId: { messages:[], pinnedMsgId:null } }
if (!fs.existsSync(dbPath('stickers'))) writeDb('stickers', {}); // { userId: [url,...] }
if (!fs.existsSync(dbPath('groups'))) writeDb('groups', []);  // [{ id, name, description, avatar, creatorId, members:[userId,...], messages:[], pinnedMsgId }]

// Seed Sticker_bot
const seedUsers = readDb('users', []);
if (!seedUsers.find(u => u.username === 'Sticker_bot')) {
  seedUsers.push({ id: 'sticker_bot', name: 'Sticker_bot', username: 'Sticker_bot', email: 'sticker_bot@mimigraf.internal', passwordHash: '', bio: 'Отправь фото — получишь стикер!', avatar: null, showOnline: true, createdAt: Date.now(), isBot: true });
  writeDb('users', seedUsers);
}

// ── Middleware ──
app.use(express.json({ limit: '20mb' }));
app.use(express.static(PUB_DIR));
app.use(session({
  store: new FileStore({ path: SESS_DIR, logFn: () => {} }),
  secret: 'mimigraf_2024_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 3600 * 1000 }
}));

const auth = (req, res, next) => req.session.userId ? next() : res.status(401).json({ error: 'Unauthorized' });
const safe = ({ passwordHash, ...u }) => u;

// ══════════════════════════════
//  AUTH ROUTES
// ══════════════════════════════
app.post('/api/register', async (req, res) => {
  const { email, username, password, passwordConfirm } = req.body;
  if (!email || !username || !password) return res.status(400).json({ error: 'Заполните все поля' });
  if (password !== passwordConfirm) return res.status(400).json({ error: 'Пароли не совпадают' });
  if (password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
  const users = readDb('users', []);
  if (users.find(u => u.email === email)) return res.status(400).json({ error: 'Email уже используется' });
  if (users.find(u => u.username === username)) return res.status(400).json({ error: 'Username занят' });
  const user = { id: gid(), email, username, name: username, passwordHash: await bcrypt.hash(password, 10), bio: '', avatar: null, showOnline: true, createdAt: Date.now(), isBot: false };
  users.push(user);
  writeDb('users', users);
  req.session.userId = user.id;
  res.json({ ok: true, user: safe(user) });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const users = readDb('users', []);
  const user = users.find(u => u.email === email && !u.isBot);
  if (!user) return res.status(401).json({ error: 'Неверные данные' });
  if (!await bcrypt.compare(password, user.passwordHash)) return res.status(401).json({ error: 'Неверный пароль' });
  req.session.userId = user.id;
  res.json({ ok: true, user: safe(user) });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get('/api/me', auth, (req, res) => {
  const u = readDb('users', []).find(u => u.id === req.session.userId);
  if (!u) return res.status(401).json({ error: 'Not found' });
  res.json(safe(u));
});

// ── USERNAME CHECK ──
app.get('/api/check-username', (req, res) => {
  const username = (req.query.username || '').trim();
  const taken = !!readDb('users', []).find(u => u.username === username);
  res.json({ available: !taken });
});

// ── PROFILE UPDATE ──
app.patch('/api/profile', auth, (req, res) => {
  const users = readDb('users', []);
  const idx = users.findIndex(u => u.id === req.session.userId);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const { name, username, bio, avatar } = req.body;
  if (username && username !== users[idx].username) {
    if (users.find(u => u.username === username && u.id !== req.session.userId)) return res.status(400).json({ error: 'Username занят' });
    users[idx].username = username;
  }
  if (name) users[idx].name = name;
  if (bio !== undefined) users[idx].bio = bio;
  if (avatar !== undefined) users[idx].avatar = avatar;
  writeDb('users', users);
  res.json({ ok: true, user: safe(users[idx]) });
});

// ── SEARCH ──
app.get('/api/search', auth, (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const users = readDb('users', []);
  const results = users
    .filter(u => u.id !== req.session.userId)
    .filter(u => u.username.toLowerCase().includes(q) || u.name.toLowerCase().includes(q))
    .slice(0, 10)
    .map(u => ({ ...safe(u), online: onlineUsers.has(u.id) }));
  res.json(results);
});

// ══════════════════════════════
//  CHATS
// ══════════════════════════════
app.get('/api/chats', auth, (req, res) => {
  const userId = req.session.userId;
  const chatsDb = readDb('chats', {});
  const users = readDb('users', []);
  const result = [];

  // Favorites
  const favId = `favorites_${userId}`;
  const favChat = chatsDb[favId] || { messages: [], pinnedMsgId: null };
  result.push({ id: favId, name: 'Избранное', username: 'favorites', avatar: null, online: false, userId: null, messages: favChat.messages || [], pinnedMsgId: favChat.pinnedMsgId });

  // DMs
  Object.keys(chatsDb).forEach(chatId => {
    if (chatId.startsWith('favorites_') || chatId.startsWith('group_')) return;
    const parts = chatId.split('_');
    if (!parts.includes(userId)) return;
    const otherId = parts.find(p => p !== userId);
    const other = users.find(u => u.id === otherId);
    if (!other) return;
    const c = chatsDb[chatId];
    result.push({ id: chatId, userId: other.id, name: other.name, username: other.username, avatar: other.avatar, bio: other.bio, online: onlineUsers.has(other.id), messages: c.messages || [], pinnedMsgId: c.pinnedMsgId });
  });

  res.json(result);
});

// ── STICKERS ──
app.get('/api/stickers', auth, (req, res) => {
  const stickers = readDb('stickers', {});
  const my = stickers[req.session.userId] || [];
  res.json(my.map(url => ({ url })));
});

// ══════════════════════════════
//  GROUPS
// ══════════════════════════════
app.get('/api/groups', auth, (req, res) => {
  const userId = req.session.userId;
  const users = readDb('users', []);
  const groups = readDb('groups', []).filter(g => g.members.includes(userId)).map(g => enrichGroup(g, users));
  res.json(groups);
});

app.post('/api/groups', auth, (req, res) => {
  const { name, description, avatar } = req.body;
  if (!name) return res.status(400).json({ error: 'Название обязательно' });
  const users = readDb('users', []);
  const me = users.find(u => u.id === req.session.userId);
  const group = {
    id: 'group_' + gid(),
    name, description: description || '', avatar: avatar || null,
    creatorId: req.session.userId,
    members: [req.session.userId],
    messages: [], pinnedMsgId: null,
    createdAt: Date.now()
  };
  const groups = readDb('groups', []);
  groups.push(group);
  writeDb('groups', groups);
  // Init chats db entry
  const chatsDb = readDb('chats', {});
  chatsDb[group.id] = { messages: [], pinnedMsgId: null };
  writeDb('chats', chatsDb);
  res.json(enrichGroup(group, users));
});

app.get('/api/groups/:id', auth, (req, res) => {
  const userId = req.session.userId;
  const groups = readDb('groups', []);
  const group = groups.find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Не найдено' });
  if (!group.members.includes(userId)) return res.status(403).json({ error: 'Нет доступа' });
  const users = readDb('users', []);
  res.json(enrichGroup(group, users));
});

app.patch('/api/groups/:id', auth, (req, res) => {
  const userId = req.session.userId;
  const groups = readDb('groups', []);
  const idx = groups.findIndex(g => g.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Не найдено' });
  if (groups[idx].creatorId !== userId) return res.status(403).json({ error: 'Только создатель' });
  const { name, description, avatar } = req.body;
  if (name) groups[idx].name = name;
  if (description !== undefined) groups[idx].description = description;
  if (avatar !== undefined) groups[idx].avatar = avatar;
  writeDb('groups', groups);
  const users = readDb('users', []);
  const enriched = enrichGroup(groups[idx], users);
  io.to(groups[idx].id).emit('groupUpdated', enriched);
  res.json(enriched);
});

// Add member
app.post('/api/groups/:id/members', auth, (req, res) => {
  const { username } = req.body;
  const groups = readDb('groups', []);
  const idx = groups.findIndex(g => g.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Группа не найдена' });
  if (!groups[idx].members.includes(req.session.userId)) return res.status(403).json({ error: 'Нет доступа' });

  const users = readDb('users', []);
  const target = users.find(u => u.username === username);
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
  if (target.isBot) return res.status(400).json({ error: 'Бота нельзя добавить в группу' });
  if (groups[idx].members.includes(target.id)) return res.status(400).json({ error: 'Уже в группе' });

  groups[idx].members.push(target.id);
  writeDb('groups', groups);
  const enriched = enrichGroup(groups[idx], users);
  io.to(groups[idx].id).emit('groupUpdated', enriched);
  res.json(enriched);
});

// Remove member
app.delete('/api/groups/:id/members/:userId', auth, (req, res) => {
  const groups = readDb('groups', []);
  const idx = groups.findIndex(g => g.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Не найдено' });
  if (groups[idx].creatorId !== req.session.userId) return res.status(403).json({ error: 'Только создатель' });
  groups[idx].members = groups[idx].members.filter(m => m !== req.params.userId);
  writeDb('groups', groups);
  const users = readDb('users', []);
  const enriched = enrichGroup(groups[idx], users);
  io.to(groups[idx].id).emit('groupUpdated', enriched);
  res.json(enriched);
});

// Leave group
app.post('/api/groups/:id/leave', auth, (req, res) => {
  const userId = req.session.userId;
  const groups = readDb('groups', []);
  const idx = groups.findIndex(g => g.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Не найдено' });
  const users = readDb('users', []);
  const me = users.find(u => u.id === userId);

  groups[idx].members = groups[idx].members.filter(m => m !== userId);

  // Send leave message
  const leaveMsg = { id: gid(), chatId: groups[idx].id, senderId: 'system', senderName: 'System', type: 'text', text: `${me.name} покинул(а) группу. Пока 👋`, time: Date.now(), isSystem: true };
  const chatsDb = readDb('chats', {});
  if (!chatsDb[groups[idx].id]) chatsDb[groups[idx].id] = { messages: [], pinnedMsgId: null };
  chatsDb[groups[idx].id].messages.push(leaveMsg);
  writeDb('chats', chatsDb);
  writeDb('groups', groups);

  io.to(groups[idx].id).emit('message', leaveMsg);
  res.json({ ok: true });
});

function enrichGroup(g, users) {
  const chatsDb = readDb('chats', {});
  const chatEntry = chatsDb[g.id] || { messages: [], pinnedMsgId: null };
  return {
    ...g,
    members: g.members.map(id => {
      const u = users.find(x => x.id === id);
      return u ? { id: u.id, name: u.name, username: u.username, avatar: u.avatar } : { id, name: 'Unknown', username: 'unknown', avatar: null };
    }),
    messages: chatEntry.messages || [],
    pinnedMsgId: chatEntry.pinnedMsgId
  };
}

// ══════════════════════════════
//  ONLINE MAP
// ══════════════════════════════
const onlineUsers = new Map(); // userId -> Set<socketId>
const userSockets = new Map(); // socketId -> userId

// ══════════════════════════════
//  SOCKET.IO
// ══════════════════════════════
io.on('connection', socket => {

  socket.on('auth', ({ userId }) => {
    if (!userId) return;
    userSockets.set(socket.id, userId);
    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socket.id);
    const u = readDb('users', []).find(u => u.id === userId);
    if (u && u.showOnline !== false) socket.broadcast.emit('userStatus', { userId, online: true });
  });

  socket.on('disconnect', () => {
    const userId = userSockets.get(socket.id);
    if (userId) {
      const set = onlineUsers.get(userId);
      if (set) { set.delete(socket.id); if (set.size === 0) { onlineUsers.delete(userId); socket.broadcast.emit('userStatus', { userId, online: false }); } }
      userSockets.delete(socket.id);
    }
  });

  socket.on('joinChat', ({ chatId }) => socket.join(chatId));

  socket.on('startChat', ({ chatId, withUserId }) => {
    const chatsDb = readDb('chats', {});
    if (!chatsDb[chatId]) { chatsDb[chatId] = { messages: [], pinnedMsgId: null }; writeDb('chats', chatsDb); }
  });

  socket.on('message', msg => {
    // Save to DB
    const chatsDb = readDb('chats', {});
    if (!chatsDb[msg.chatId]) chatsDb[msg.chatId] = { messages: [], pinnedMsgId: null };
    chatsDb[msg.chatId].messages.push(msg);
    writeDb('chats', chatsDb);

    // Broadcast
    socket.to(msg.chatId).emit('message', msg);

    // Sticker_bot
    if (msg.chatId.includes('sticker_bot') && msg.senderId !== 'sticker_bot') {
      handleStickerBot(msg);
    }
  });

  socket.on('typing', data => socket.to(data.chatId).emit('typing', data));

  socket.on('editMessage', ({ chatId, msgId, text }) => {
    const chatsDb = readDb('chats', {});
    if (chatsDb[chatId]) {
      const m = chatsDb[chatId].messages.find(x => x.id === msgId);
      if (m) { m.text = text; m.edited = true; writeDb('chats', chatsDb); }
    }
    io.to(chatId).emit('messageUpdated', { chatId, msgId, text });
  });

  socket.on('deleteMessage', ({ chatId, msgId }) => {
    const chatsDb = readDb('chats', {});
    if (chatsDb[chatId]) {
      chatsDb[chatId].messages = chatsDb[chatId].messages.filter(x => x.id !== msgId);
      if (chatsDb[chatId].pinnedMsgId === msgId) chatsDb[chatId].pinnedMsgId = null;
      writeDb('chats', chatsDb);
    }
    io.to(chatId).emit('messageDeleted', { chatId, msgId });
  });

  socket.on('reaction', ({ chatId, msgId, emoji, username }) => {
    const chatsDb = readDb('chats', {});
    if (chatsDb[chatId]) {
      const m = chatsDb[chatId].messages.find(x => x.id === msgId);
      if (m) {
        if (!m.reactions) m.reactions = {};
        if (!m.reactions[emoji]) m.reactions[emoji] = [];
        if (!m.reactions[emoji].includes(username)) m.reactions[emoji].push(username);
        writeDb('chats', chatsDb);
      }
    }
    io.to(chatId).emit('reaction', { chatId, msgId, emoji, username });
  });

  socket.on('pinMessage', ({ chatId, msgId }) => {
    const chatsDb = readDb('chats', {});
    if (!chatsDb[chatId]) chatsDb[chatId] = { messages: [], pinnedMsgId: null };
    chatsDb[chatId].pinnedMsgId = msgId;
    writeDb('chats', chatsDb);
    io.to(chatId).emit('pinMessage', { chatId, msgId });
  });

  socket.on('setOnlineVisibility', ({ visible }) => {
    const userId = userSockets.get(socket.id);
    if (!userId) return;
    const users = readDb('users', []);
    const u = users.find(x => x.id === userId);
    if (u) { u.showOnline = visible; writeDb('users', users); }
    socket.broadcast.emit('userStatus', { userId, online: visible && onlineUsers.has(userId) });
  });
});

// ══════════════════════════════
//  STICKER BOT
// ══════════════════════════════
function handleStickerBot(msg) {
  const userId = msg.senderId;
  const chatId = msg.chatId;
  setTimeout(() => {
    let text;
    if (msg.text === '/start') {
      text = 'Привет! Отправь мне фото и я превращу его в стикер 🎨';
    } else if (msg.type === 'image') {
      // Save sticker
      const stickers = readDb('stickers', {});
      if (!stickers[userId]) stickers[userId] = [];
      stickers[userId].push(msg.content);
      writeDb('stickers', stickers);
      text = `Отлично! Стикер #${stickers[userId].length} сохранён ✅`;
    } else {
      text = 'Отправь мне фото, чтобы создать стикер 📸';
    }
    const botMsg = { id: gid(), chatId, senderId: 'sticker_bot', senderName: 'Sticker_bot', type: 'text', text, time: Date.now() };
    const chatsDb = readDb('chats', {});
    if (!chatsDb[chatId]) chatsDb[chatId] = { messages: [], pinnedMsgId: null };
    chatsDb[chatId].messages.push(botMsg);
    writeDb('chats', chatsDb);
    io.to(chatId).emit('message', botMsg);
  }, 800);
}

function gid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

server.listen(PORT, () => console.log(`✅ MIMIgraf → http://localhost:${PORT}`));
