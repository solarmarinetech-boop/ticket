const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ── Config ──
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROK_API_KEY = process.env.GROK_API_KEY;
const PORT = process.env.PORT || 3000;

if (!TELEGRAM_TOKEN) console.warn('⚠️  TELEGRAM_TOKEN not set in environment variables');
if (!GROK_API_KEY) console.warn('⚠️  GROK_API_KEY not set in environment variables');
const DB_FILE = path.join(__dirname, 'tickets.json');

// ── Simple JSON "database" ──
function loadTickets() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {}
  return [];
}

function saveTickets(tickets) {
  fs.writeFileSync(DB_FILE, JSON.stringify(tickets, null, 2), 'utf8');
}

function generateId(tickets) {
  const max = tickets.reduce((m, t) => {
    const n = parseInt(t.id.replace('TKT-', ''), 10);
    return n > m ? n : m;
  }, 46);
  return 'TKT-' + String(max + 1).padStart(4, '0');
}

// ── Grok (xAI) processing ──
async function processWithGrok(rawText, username) {
  if (!GROK_API_KEY) throw new Error('GROK_API_KEY is not set in environment variables');
  const prompt = `Ты — система обработки заявок в IT Service Desk. Пользователь написал в Telegram:

"${rawText}"

Формализуй заявку и верни ТОЛЬКО JSON без markdown-обёртки:
{
  "title": "краткое название проблемы (до 60 символов)",
  "summary": "понятное описание проблемы (2-3 предложения)",
  "priority": "critical | high | medium | low",
  "department": "предполагаемый отдел или 'Неизвестно'",
  "tasks": ["задача 1 для IT-администратора", "задача 2", "задача 3"]
}

Приоритет critical — если система полностью не работает или блокирует бизнес-процессы.
Приоритет high — серьёзная проблема, есть обходной путь.
Приоритет medium — неудобство, но работа возможна.
Приоритет low — улучшение или некритичный запрос.`;

  const resp = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROK_API_KEY}`
    },
    body: JSON.stringify({
      model: 'grok-3-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 1000
    })
  });

  const data = await resp.json();
  if (data.error) throw new Error(data.error.message);

  const text = data.choices?.[0]?.message?.content || '';
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ── Telegram Bot ──
let bot;
try {
  bot = new TelegramBot(TELEGRAM_TOKEN, {
    polling: {
      autoStart: true,
      params: { timeout: 10 }
    }
  });

  // Drop pending updates on start to avoid 409 conflicts
  bot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const rawText = msg.text;
    const username = msg.from.username
      ? '@' + msg.from.username
      : (msg.from.first_name || 'Пользователь');

    if (!rawText) return;

    if (rawText === '/start') {
      return bot.sendMessage(chatId,
        '👋 Привет! Я принимаю заявки в IT Service Desk.\n\nПросто напиши свою проблему в свободной форме — я передам её администраторам.'
      );
    }

    if (rawText.startsWith('/')) return;

    bot.sendMessage(chatId, '⏳ Получил твою заявку, обрабатываю...');

    try {
      const tickets = loadTickets();
      const parsed = await processWithGrok(rawText, username);

      const now = new Date();
      const newTicket = {
        id: generateId(tickets),
        title: parsed.title || 'Новая заявка',
        summary: parsed.summary || rawText,
        priority: parsed.priority || 'medium',
        status: 'new',
        from: username,
        telegramChatId: chatId,
        department: parsed.department || 'Неизвестно',
        time: now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
        date: now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }),
        rawText,
        tasks: (parsed.tasks || ['Рассмотреть заявку']).map(t => ({ text: t, done: false })),
        createdAt: now.toISOString()
      };

      tickets.unshift(newTicket);
      saveTickets(tickets);

      const priorityEmoji = { critical: '🚨', high: '🔴', medium: '🟡', low: '🟢' }[newTicket.priority] || '📋';

      bot.sendMessage(chatId,
        `✅ Заявка принята!\n\n` +
        `🆔 *${newTicket.id}*\n` +
        `${priorityEmoji} Приоритет: *${newTicket.priority}*\n` +
        `📝 ${newTicket.title}\n\n` +
        `Администратор скоро возьмёт её в работу.`,
        { parse_mode: 'Markdown' }
      );

      console.log(`[BOT] New ticket ${newTicket.id} from ${username}`);

    } catch (err) {
      console.error('[BOT] Error:', err.message || JSON.stringify(err));
      if (!GROK_API_KEY) console.error('[BOT] GROK_API_KEY is not set!');
      bot.sendMessage(chatId,
        '⚠️ Ошибка при обработке заявки. Попробуй ещё раз или обратись напрямую к администратору.'
      );
    }
  });

  bot.on('polling_error', (err) => console.error('[BOT] Polling error:', err.message));
  console.log('✅ Telegram bot started');

} catch (e) {
  console.warn('⚠️  Telegram bot not started (check TELEGRAM_TOKEN):', e.message);
}

// ── REST API for frontend ──

// Get all tickets
app.get('/api/tickets', (req, res) => {
  res.json(loadTickets());
});

// Update ticket (status, tasks)
app.patch('/api/tickets/:id', (req, res) => {
  const tickets = loadTickets();
  const idx = tickets.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  tickets[idx] = { ...tickets[idx], ...req.body };
  saveTickets(tickets);

  // Notify user in Telegram when ticket is closed
  if (req.body.status === 'done' && tickets[idx].telegramChatId && bot) {
    bot.sendMessage(tickets[idx].telegramChatId,
      `✅ Ваша заявка *${tickets[idx].id}* закрыта!\n📝 ${tickets[idx].title}\n\nЕсли проблема не решена — напишите снова.`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }

  res.json(tickets[idx]);
});

// Create ticket manually from web UI
app.post('/api/tickets', async (req, res) => {
  const { rawText, username } = req.body;
  if (!rawText) return res.status(400).json({ error: 'rawText required' });

  try {
    const tickets = loadTickets();
    const parsed = await processWithGrok(rawText, username || '@manual');
    const now = new Date();

    const newTicket = {
      id: generateId(tickets),
      title: parsed.title || 'Новая заявка',
      summary: parsed.summary || rawText,
      priority: parsed.priority || 'medium',
      status: 'new',
      from: username || '@manual',
      department: parsed.department || 'Неизвестно',
      time: now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
      date: now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }),
      rawText,
      tasks: (parsed.tasks || ['Рассмотреть заявку']).map(t => ({ text: t, done: false })),
      createdAt: now.toISOString()
    };

    tickets.unshift(newTicket);
    saveTickets(tickets);
    res.json(newTicket);

  } catch (err) {
    console.error('[API] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log(`🚢 NavDesk server running on port ${PORT}`));
