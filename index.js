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
                is_completed BOOLEAN DEFAULT FALSE
            );
        `);
        // Добавляем колонку для подзадач
        await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS subtasks JSONB DEFAULT '[]';`);
        console.log("База данных проверена и готова");
    } catch (e) { console.error("Ошибка БД:", e); }
}
initDB();

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());
app.use(express.static('public'));

bot.start((ctx) => {
    ctx.reply('Привет! Твой личный ежедневник готов 📅', {
        reply_markup: { inline_keyboard: [[ { text: 'Открыть ежедневник', web_app: { url: process.env.WEBAPP_URL } } ]] }
    });
});
bot.launch();

// API Ежедневника
app.get('/api/events', async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM events WHERE user_id = $1 ORDER BY event_date ASC', [req.query.userId]);
    res.json(rows);
});

app.post('/api/events', async (req, res) => {
    const { userId, title, dates, notifyPrefs, comment, isAllDay, color, subtasks } = req.body;
    for (const d of dates) {
        await pool.query(
            'INSERT INTO events (user_id, title, event_date, notify_prefs, comment, is_all_day, color, subtasks) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [userId, title, new Date(d), JSON.stringify(notifyPrefs), comment || null, isAllDay || false, color || 'blue', JSON.stringify(subtasks || [])]
        );
    }
    res.json({ success: true });
});

app.put('/api/events/:id', async (req, res) => {
    const { title, date, notifyPrefs, comment, isAllDay, color, subtasks } = req.body;
    await pool.query(
        `UPDATE events SET title=$1, event_date=$2, notify_prefs=$3, comment=$4, is_all_day=$5, color=$6, subtasks=$7, sent_notifications='[]' WHERE id=$8`,
        [title, new Date(date), JSON.stringify(notifyPrefs), comment || null, isAllDay || false, color || 'blue', JSON.stringify(subtasks || []), req.params.id]
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

// НОВОЕ: Экспорт в Apple Calendar (.ics)
app.get('/api/calendar/:userId.ics', async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM events WHERE user_id = $1', [req.params.userId]);
    
    let ics = 'BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//TelegramPlanner//RU\nCALSCALE:GREGORIAN\n';
    
    rows.forEach(ev => {
        const d = new Date(ev.event_date);
        ics += 'BEGIN:VEVENT\n';
        ics += `UID:event-${ev.id}@tgplanner\n`;
        ics += `SUMMARY:${ev.title}\n`;
        if (ev.comment) ics += `DESCRIPTION:${ev.comment}\n`;
        
        if (ev.is_all_day) {
            const dateStr = d.toISOString().replace(/[-:]/g, '').split('T')[0];
            ics += `DTSTART;VALUE=DATE:${dateStr}\n`;
        } else {
            const dtStr = d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
            ics += `DTSTART:${dtStr}\n`;
            d.setHours(d.getHours() + 1); // По умолчанию длительность 1 час
            const dtEndStr = d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
            ics += `DTEND:${dtEndStr}\n`;
        }
        ics += 'END:VEVENT\n';
    });
    ics += 'END:VCALENDAR';
    
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Planner_${req.params.userId}.ics"`);
    res.send(ics);
});

// Крон: Утренняя сводка (каждый день в 08:00 утра)
cron.schedule('0 8 * * *', async () => {
    try {
        const { rows: events } = await pool.query(`SELECT * FROM events WHERE DATE(event_date) = CURRENT_DATE AND is_completed = FALSE`);
        
        // Группируем дела по пользователям
        const userEvents = {};
        events.forEach(ev => {
            if (!userEvents[ev.user_id]) userEvents[ev.user_id] = [];
            userEvents[ev.user_id].push(ev);
        });

        for (const [userId, evs] of Object.entries(userEvents)) {
            let msg = `☀️ **Доброе утро!**\nПлан на сегодня (${evs.length} дел):\n\n`;
            evs.sort((a,b) => new Date(a.event_date) - new Date(b.event_date)).forEach(ev => {
                const timeStr = ev.is_all_day ? 'Весь день' : new Date(ev.event_date).toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'});
                const colorEmoji = {'blue':'🔵', 'red':'🔴', 'green':'🟢', 'orange':'🟠', 'purple':'🟣'}[ev.color] || '🔵';
                msg += `${colorEmoji} **${ev.title}** (${timeStr})\n`;
            });
            msg += `\nПродуктивного дня! 🚀`;
            await bot.telegram.sendMessage(userId, msg, { parse_mode: 'Markdown' }).catch(()=>{});
        }
    } catch (e) { console.error('Ошибка утренней сводки:', e); }
});

// Крон: Обычные напоминания
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
