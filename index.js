require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS events (
                id SERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL,
                title TEXT NOT NULL,
                event_date TIMESTAMP NOT NULL,
                notify_prefs JSONB NOT NULL,
                sent_notifications JSONB DEFAULT '[]',
                comment TEXT,
                is_all_day BOOLEAN DEFAULT FALSE,
                color VARCHAR(20) DEFAULT 'blue',
                is_completed BOOLEAN DEFAULT FALSE,
                subtasks JSONB DEFAULT '[]'
            );
        `);
        // НОВОЕ: Добавляем колонку для времени окончания
        await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS end_date TIMESTAMP;`);
        console.log("База данных проверена и готова");
    } catch (e) { console.error("Ошибка БД:", e); }
}
initDB();

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());
app.use(express.static('public'));

bot.start((ctx) => {
    ctx.reply('Привет! Твой личный ежедневник готов 📅\n\nЯ умею распознавать текст (напиши "завтра в 15:00 тренировка").\nА еще ты можешь упомянуть меня в любом чате (@твой_бот), чтобы быстро скинуть свои планы друзьям!', {
        reply_markup: { inline_keyboard: [[ { text: 'Открыть ежедневник', web_app: { url: process.env.WEBAPP_URL } } ]] }
    });
});

// Вспомогательная функция для безопасного текста в ТГ
const escapeHtmlBot = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ИНЛАЙН-РЕЖИМ (Шеринг планов в других чатах)
bot.on('inline_query', async (ctx) => {
    try {
        const userId = ctx.from.id;
        const searchQuery = ctx.inlineQuery.query.toLowerCase().trim(); // Текст, который юзер пишет после @имени_бота
        
        // Получаем все дела пользователя
        const { rows: events } = await pool.query('SELECT * FROM events WHERE user_id = $1 ORDER BY event_date ASC', [userId]);
        
        if (!events || events.length === 0) {
            return ctx.answerInlineQuery([{
                type: 'article', id: 'empty', title: 'Нет планов', description: 'Ваш график пуст',
                input_message_content: { message_text: 'Я абсолютно свободен! Никаких планов нет. 😎' }
            }], { cache_time: 0, is_personal: true });
        }

        // Вычисляем сегодняшнюю и завтрашнюю даты
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const getIsoDate = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        const todayStr = getIsoDate(today);
        const tomorrowStr = getIsoDate(tomorrow);

        // Фильтруем дела по дате
        let todayEvents = events.filter(e => getIsoDate(new Date(e.event_date)) === todayStr);
        let tomorrowEvents = events.filter(e => getIsoDate(new Date(e.event_date)) === tomorrowStr);

        // Если юзер что-то написал, фильтруем по названию
        if (searchQuery) {
            todayEvents = todayEvents.filter(e => e.title.toLowerCase().includes(searchQuery));
            tomorrowEvents = tomorrowEvents.filter(e => e.title.toLowerCase().includes(searchQuery));
        }

        const formatEvents = (evs, title) => {
            if (evs.length === 0) return `На ${title.toLowerCase()} у меня нет планов! 🏖`;
            let txt = `📅 <b>Мой план на ${title.toLowerCase()}:</b>\n\n`;
            evs.forEach(ev => {
                let timeStr = ev.is_all_day ? '(Весь день)' : new Date(ev.event_date).toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'});
                if (!ev.is_all_day && ev.end_date) {
                    timeStr += ` - ${new Date(ev.end_date).toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'})}`;
                }
                const emoji = ev.is_completed ? '✅' : '🔹';
                txt += `${emoji} ${escapeHtmlBot(ev.title)} <i>${timeStr}</i>\n`;
            });
            return txt;
        };

        const results = [];

        // Добавляем результаты только если там что-то есть, либо если мы ничего не искали
        if (todayEvents.length > 0 || !searchQuery) {
            results.push({
                type: 'article', id: 'today',
                title: 'План на сегодня',
                description: `Дел: ${todayEvents.length}`,
                input_message_content: { message_text: formatEvents(todayEvents, 'Сегодня'), parse_mode: 'HTML' }
            });
        }

        if (tomorrowEvents.length > 0 || !searchQuery) {
            results.push({
                type: 'article', id: 'tomorrow',
                title: 'План на завтра',
                description: `Дел: ${tomorrowEvents.length}`,
                input_message_content: { message_text: formatEvents(tomorrowEvents, 'Завтра'), parse_mode: 'HTML' }
            });
        }

        // Если искали, но ничего не нашли
        if (results.length === 0) {
            results.push({
                type: 'article', id: 'not_found',
                title: 'Ничего не найдено',
                description: 'По вашему запросу нет совпадений',
                input_message_content: { message_text: `По запросу "<b>${escapeHtmlBot(searchQuery)}</b>" ничего не найдено 🤷‍♂️`, parse_mode: 'HTML' }
            });
        }

        // is_personal: true — гарантия того, что Telegram не покажет ваши дела другим людям из глобального кэша
        return ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true });
        
    } catch (e) { 
        console.error('Ошибка инлайн-режима:', e); 
    }
});

bot.launch();

// API Ежедневника
app.get('/api/events', async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM events WHERE user_id = $1 ORDER BY event_date ASC', [req.query.userId]);
    res.json(rows);
});

app.post('/api/events', async (req, res) => {
    const { userId, title, dates, endDates, notifyPrefs, comment, isAllDay, color, subtasks } = req.body;
    for (let i = 0; i < dates.length; i++) {
        await pool.query(
            'INSERT INTO events (user_id, title, event_date, end_date, notify_prefs, comment, is_all_day, color, subtasks) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
            [userId, title, new Date(dates[i]), endDates[i] ? new Date(endDates[i]) : null, JSON.stringify(notifyPrefs), comment || null, isAllDay || false, color || 'blue', JSON.stringify(subtasks || [])]
        );
    }
    res.json({ success: true });
});

app.put('/api/events/:id', async (req, res) => {
    const { title, date, endDate, notifyPrefs, comment, isAllDay, color, subtasks } = req.body;
    await pool.query(
        `UPDATE events SET title=$1, event_date=$2, end_date=$3, notify_prefs=$4, comment=$5, is_all_day=$6, color=$7, subtasks=$8, sent_notifications='[]' WHERE id=$9`,
        [title, new Date(date), endDate ? new Date(endDate) : null, JSON.stringify(notifyPrefs), comment || null, isAllDay || false, color || 'blue', JSON.stringify(subtasks || []), req.params.id]
    );
    res.json({ success: true });
});

app.delete('/api/events/:id', async (req, res) => {
    await pool.query('DELETE FROM events WHERE id = $1', [req.params.id]);
    res.json({ success: true });
});

app.post('/api/events/bulk-delete', async (req, res) => {
    if (!req.body.ids || req.body.ids.length === 0) return res.json({ success: true });
    await pool.query('DELETE FROM events WHERE id = ANY($1::int[])', [req.body.ids]);
    res.json({ success: true });
});

app.patch('/api/events/:id/toggle', async (req, res) => {
    const { isCompleted } = req.body;
    await pool.query('UPDATE events SET is_completed = $1 WHERE id = $2', [isCompleted, req.params.id]);
    res.json({ success: true });
});

app.patch('/api/events/:id/subtasks', async (req, res) => {
    const { subtasks } = req.body;
    await pool.query('UPDATE events SET subtasks = $1 WHERE id = $2', [JSON.stringify(subtasks), req.params.id]);
    res.json({ success: true });
});

// НОВОЕ: ИСПРАВЛЕННЫЙ ЭКСПОРТ (Бот присылает файл в чат)
app.post('/api/export', async (req, res) => {
    try {
        const userId = req.body.userId;
        const { rows } = await pool.query('SELECT * FROM events WHERE user_id = $1', [userId]);
        
        let ics = 'BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//TelegramPlanner//RU\nCALSCALE:GREGORIAN\n';
        
        const formatICSDate = (date) => date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

        rows.forEach(ev => {
            const startDate = new Date(ev.event_date);
            const endDate = ev.end_date ? new Date(ev.end_date) : new Date(startDate.getTime() + 60 * 60 * 1000); // +1 час по умолчанию

            ics += 'BEGIN:VEVENT\n';
            ics += `UID:event-${ev.id}@tgplanner\n`;
            ics += `SUMMARY:${ev.title}\n`;
            if (ev.comment) ics += `DESCRIPTION:${ev.comment}\n`;
            
            if (ev.is_all_day) {
                const dateStr = startDate.toISOString().replace(/[-:]/g, '').split('T')[0];
                ics += `DTSTART;VALUE=DATE:${dateStr}\n`;
            } else {
                ics += `DTSTART:${formatICSDate(startDate)}\n`;
                ics += `DTEND:${formatICSDate(endDate)}\n`;
            }
            ics += 'END:VEVENT\n';
        });
        ics += 'END:VCALENDAR';
        
        const buffer = Buffer.from(ics, 'utf-8');
        await bot.telegram.sendDocument(userId, { source: buffer, filename: 'My_Calendar.ics' });
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false });
    }
});

// Крон для уведомлений
cron.schedule('* * * * *', async () => {
    const now = new Date();
    try {
        const { rows: events } = await pool.query('SELECT * FROM events WHERE event_date > NOW() AND is_completed = FALSE');
        for (const event of events) {
            const diffMinutes = Math.floor((new Date(event.event_date) - now) / 60000);
            const prefs = event.notify_prefs || [];
            const sent = event.sent_notifications || [];
            for (const pref of prefs) {
                if (diffMinutes <= pref && diffMinutes > pref - 2 && !sent.includes(pref)) {
                    const timeText = pref >= 60 ? (pref/60) + ' ч.' : pref + ' мин.';
                    await bot.telegram.sendMessage(event.user_id, `🔔 Напоминание!\nСобытие: **${event.title}**${event.comment ? `\n📝 ${event.comment}` : ''}\nНачнется через ${timeText}`);
                    sent.push(pref);
                    await pool.query('UPDATE events SET sent_notifications = $1 WHERE id = $2', [JSON.stringify(sent), event.id]);
                }
            }
        }
    } catch (e) { console.error('Ошибка крона:', e); }
});

app.listen(process.env.PORT || 3000, () => console.log('Сервер запущен'));
