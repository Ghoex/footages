require('dotenv').config();

const path = require('path');
const multer = require('multer');
const express = require('express');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto'); // перенесено сюда из низа файла — нужен раньше, для секрета сессии

const app = express();
const PORT = process.env.PORT || 80;
const SOUNDS_DIR = path.join(__dirname, 'sounds');

// ============================================================
// ЛИМИТЫ / КОНСТАНТЫ
// ============================================================
const MAX_COLLECTIONS_PER_USER = 6; // <-- лимит коллекций на аккаунт

// ============================================================
// РОЛИ
//
// user             — обычный пользователь
// junior_moderator — мл. модератор: базовые права модератора + может
//                    выдавать/снимать ТЕГИ пользователям
// senior_moderator — ст. модератор: базовые права модератора + может
//                    выдавать/снимать ВЕРИФИКАЦИЮ (синяя галочка)
// moderator        — обычный модератор (как было раньше): базовые
//                    права модератора без тегов/верификации
// admin            — полный доступ, включая выдачу тегов и верификации
// ============================================================
const STAFF_ROLES = ['admin', 'moderator', 'junior_moderator', 'senior_moderator'];
const TAG_GRANTER_ROLES = ['admin', 'senior_moderator', 'junior_moderator'];
const VERIFIER_ROLES = ['admin', 'senior_moderator'];

// ============================================================
// TELEGRAM-УВЕДОМЛЕНИЯ
//
// Сервер и бот — разные процессы, поэтому напрямую вызвать bot.sendMessage
// отсюда нельзя. Вместо этого сервер кладёт "заявку на уведомление" в общую
// таблицу bot_notifications (та же database.db, что использует и бот), а
// бот каждые несколько секунд вычитывает необработанные записи и рассылает
// их через Telegram. Так сервер не зависит от того, запущен бот сейчас
// или нет — сообщения просто подождут в очереди.
//
// Типы уведомлений:
//   broadcast_footage   — новый одобренный футаж, шлётся ВСЕМ, кто привязал
//                         Telegram (используется поле title + link)
//   broadcast_news      — новая новость на сайте, шлётся ВСЕМ привязанным
//                         (title + message + image_path, картинка не обязательна)
//   personal_approved   — заявка пользователя на футаж одобрена, шлётся
//                         ТОЛЬКО этому пользователю, и только если у него
//                         привязан Telegram (иначе просто ничего не уйдёт)
//   personal_rejected   — заявка пользователя на футаж отклонена, аналогично
//   register_code       — код подтверждения регистрации, шлётся на
//                         target_chat_id (Telegram ID, введённый на сайте;
//                         аккаунта на сайте у этого юзера может ещё не быть)
//   login_code          — код подтверждения входа (2FA), шлётся на
//                         target_chat_id = telegram_id уже существующего
//                         и привязанного аккаунта
// ============================================================
const SITE_URL = (process.env.SITE_URL || '').replace(/\/+$/, ''); // например https://mell-footage.example — без слэша в конце

async function queueNotification({ type, targetUserId = null, targetChatId = null, title = '', message = '', imagePath = null, link = null }) {
    try {
        await db.run(
            `INSERT INTO bot_notifications
                (type, target_user_id, target_chat_id, title, message, image_path, link, created_at, processed)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
            [type, targetUserId, targetChatId, title, message, imagePath, link, new Date().toISOString()]
        );
    } catch (error) {
        // Уведомление — не критичная часть флоу (одобрение заявки/новости не
        // должно падать из-за проблем с очередью для бота), поэтому просто
        // логируем и едем дальше.
        console.error('Не удалось добавить уведомление для бота:', error);
    }
}

// ============================================================
// БЕЗОПАСНАЯ КОНФИГУРАЦИЯ HELMET + CORS
// ============================================================

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            scriptSrcAttr: ["'self'", "'unsafe-inline'"], // <-- Добавь эту строчку
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:"],
            mediaSrc: ["'self'", "http:", "https:"],
            fontSrc: ["'self'"],
            connectSrc: ["'self'"],
            frameSrc: ["'none'"],
            objectSrc: ["'none'"]
        }
    },
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginOpenerPolicy: { policy: "same-origin" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
    },
    noSniff: true,
    xssFilter: true,
    frameguard: { action: 'deny' }
}));

// ============================================================
// CORS - ОГРАНИЧЕННЫЙ
// ============================================================
const allowedOrigins = [
    'https://mfoot.skbv.online',
    /^http:\/\/localhost:\d+$/,  // localhost на любом порту
    /^http:\/\/127\.0\.0\.1:\d+$/, // 127.0.0.1 на любом порту
    /^http:\/\/192\.168\.\d+\.\d+:\d+$/ // Локальная сеть
];

const corsOptions = {
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);

        const isAllowed = allowedOrigins.some(allowed =>
            typeof allowed === 'string' ? allowed === origin : allowed.test(origin)
        );

        if (isAllowed) return callback(null, true);

        console.warn(`CORS blocked: ${origin}`);
        callback(new Error(`CORS not allowed for ${origin}`));
    },
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'User-Agent'],
    exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges'],
    maxAge: 86400
};
app.use(cors(corsOptions));
app.options('*path', cors(corsOptions));
const limiter = rateLimit({
    windowMs: 3 * 60 * 1000,
    max: 69,
    message: 'Слишком много запросов, попробуйте позже',
    standardHeaders: true,
    legacyHeaders: false
});
app.use(limiter);

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,  // только 5 попыток за 15 минут
    message: 'Слишком много попыток входа',
    standardHeaders: true
});
// ============================================================
// ПРОСТАЯ ЗАЩИТА ОТ XSS И INJECTION
// ============================================================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Функция для санитизации строк (простая защита)
function sanitizeInput(str) {
    if (typeof str !== 'string') return str;
    return str
        .replace(/[<>]/g, '')  // Удаляем < и >
        .replace(/javascript:/gi, '')  // Удаляем javascript:
        .trim();
}
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);

// ============================================================
// СЕКРЕТ СЕССИИ — раньше был захардкожен ('secretbase000') прямо в
// коде. Если этот код когда-либо попадал в публичный репозиторий,
// логи, скриншот и т.д. — секрет утекал вместе с ним. Секрет ОБЯЗАН
// быть только в .env и никогда не попадать в git.
//
// Добавьте в .env:
//   SESSION_SECRET=<длинная случайная строка, минимум 32 символа>
// Сгенерировать можно командой:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// ============================================================
if (!process.env.SESSION_SECRET) {
    console.warn(
        '⚠️  SESSION_SECRET не задан в .env! Генерирую временный случайный секрет ' +
        'на время работы процесса — ВСЕ сессии слетят при перезапуске сервера. ' +
        'Обязательно добавьте постоянный SESSION_SECRET в .env для продакшена.'
    );
}
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

app.use(session({
    store: new SQLiteStore({
        db: 'sessions.db',
        dir: './'
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        // sameSite защищает от CSRF: сторонний сайт больше не может
        // "прокатить" cookie пользователя через форму/fetch на ваш API.
        sameSite: 'lax',
        // secure=true требует HTTPS — включаем автоматически в проде.
        // Если сайт крутится без HTTPS в проде, ЛОГИН НЕ БУДЕТ РАБОТАТЬ,
        // пока не настроите SSL — это осознанный компромисс безопасности.
        secure: process.env.NODE_ENV === 'production',
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
}));

// Общий лимитер на все запросы



// ============================================================
// ОТДЕЛЬНЫЙ, СТРОГИЙ лимитер для логина/регистрации — раньше их
// защищал только общий лимит (100 запросов/мин), чего достаточно
// чтобы перебирать пароли ботом. Теперь: 10 попыток за 15 минут
// с одного IP на вход/регистрацию.
// ============================================================


app.use(express.static('public'));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// ✅ ИСПРАВЛЕНО: правильный маршрут для потокового воспроизведения видео
app.get('/videos/:filename', (req, res) => {
    const filename = req.params.filename;
    const filepath = path.join(__dirname, 'videos', filename);

    // Безопасность: проверка пути
    if (!filepath.startsWith(path.join(__dirname, 'videos'))) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Проверка расширения
    if (!ALLOWED_UPLOAD_EXTENSIONS.includes(path.extname(filename).toLowerCase())) {
        return res.status(400).json({ error: 'Invalid file type' });
    }

    // Проверка существования
    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ error: 'Video not found' });
    }

    // ✅ Определяем правильный Content-Type в зависимости от расширения
    const ext = path.extname(filename).toLowerCase();
    let contentType = 'video/mp4';
    if (ext === '.mkv') contentType = 'video/x-matroska';
    if (ext === '.webm') contentType = 'video/webm';
    if (ext === '.mov') contentType = 'video/quicktime';
    if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
    if (ext === '.png') contentType = 'image/png';
    if (ext === '.webp') contentType = 'image/webp';
    if (ext === '.gif') contentType = 'image/gif';

    const stat = fs.statSync(filepath);
    const fileSize = stat.size;
    const range = req.headers.range;

    // Поддержка Range requests
    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = end - start + 1;

        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': contentType,  // ✅ ДИНАМИЧЕСКИЙ
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=3600'
        });
        fs.createReadStream(filepath, { start, end }).pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': contentType,  // ✅ ДИНАМИЧЕСКИЙ
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=3600'
        });
        fs.createReadStream(filepath).pipe(res);
    }
});

if (!fs.existsSync(SOUNDS_DIR)) {
    fs.mkdirSync(SOUNDS_DIR, { recursive: true });
}

const ALLOWED_VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.webm', '.mov'];
const ALLOWED_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
const ALLOWED_UPLOAD_EXTENSIONS = [...ALLOWED_VIDEO_EXTENSIONS, ...ALLOWED_IMAGE_EXTENSIONS];

const videoStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'videos/');
    },
    filename: (req, file, cb) => {
        let rawName = req.body.nameof || file.originalname || 'file';

        const ext = path.extname(file.originalname).toLowerCase() || '.mp4';

        let baseName = path.basename(rawName, path.extname(rawName));

        let safeName = baseName
            .replace(/[/\\?%*:|"<>;&#]/g, '')
            .replace(/^\.+/, '') // убираем ведущие точки — защита от скрытых/служебных имён типа ".htaccess"
            .trim()
            .slice(0, 100); // ограничиваем длину имени файла

        if (!safeName) {
            safeName = 'video_' + Date.now();
        }

        cb(null, `${safeName}${ext}`);
    }
});

const videoFileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_VIDEO_EXTENSIONS.includes(ext)) {
        cb(null, true);
    } else {
        cb(new Error('Недопустимый тип файла. Разрешены: mp4, mkv, webm, mov'), false);
    }
};
const uploadVideo = multer({
    storage: videoStorage,
    fileFilter: videoFileFilter,
    limits: { fileSize: 100 * 1024 * 1024 }
});

const newsStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, 'public', 'uploads'));
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `news_${Date.now()}${ext}`);
    }
});

const newsFileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_IMAGE_EXTENSIONS.includes(ext)) {
        cb(null, true);
    } else {
        cb(new Error('Только изображения: png, jpg, jpeg, webp'), false);
    }
};

const uploadNews = multer({ storage: newsStorage, fileFilter: newsFileFilter });

function authUser(req, res, next) {
    req.user = req.session.user || null;
    next();
}

function requireAdmin(req, res, next) {
    const user = req.session.user;
    if (!user) return res.status(401).json({ error: 'Нужно войти' });
    const role = String(user.role || '').trim().toLowerCase();
    if (role !== 'admin') return res.status(403).json({ error: 'Доступ запрещён' });
    req.user = user;
    next();
}

async function requireModerator(req, res, next) {
    try {
        if (!req.session.user) return res.status(401).json({ error: 'Нужно войти' });

        const user = await db.get(
            'SELECT id, username, role FROM users WHERE id = ?',
            [req.session.user.id]
        );

        if (!user) return res.status(401).json({ error: 'Пользователь не найден' });

        const role = String(user.role || '').trim().toLowerCase();
        if (!STAFF_ROLES.includes(role)) {
            return res.status(403).json({ error: 'Доступ запрещён' });
        }

        req.user = user;
        next();
    } catch (error) {
        console.error('requireModerator error:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
}

// Может выдавать/снимать ТЕГИ: мл. модератор, ст. модератор, админ
async function requireTagGranter(req, res, next) {
    try {
        if (!req.session.user) return res.status(401).json({ error: 'Нужно войти' });

        const user = await db.get(
            'SELECT id, username, role FROM users WHERE id = ?',
            [req.session.user.id]
        );

        if (!user) return res.status(401).json({ error: 'Пользователь не найден' });

        const role = String(user.role || '').trim().toLowerCase();
        if (!TAG_GRANTER_ROLES.includes(role)) {
            return res.status(403).json({ error: 'Доступ запрещён' });
        }

        req.user = user;
        next();
    } catch (error) {
        console.error('requireTagGranter error:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
}

// Может выдавать/снимать ВЕРИФИКАЦИЮ (синюю галочку): ст. модератор, админ
async function requireVerifier(req, res, next) {
    try {
        if (!req.session.user) return res.status(401).json({ error: 'Нужно войти' });

        const user = await db.get(
            'SELECT id, username, role FROM users WHERE id = ?',
            [req.session.user.id]
        );

        if (!user) return res.status(401).json({ error: 'Пользователь не найден' });

        const role = String(user.role || '').trim().toLowerCase();
        if (!VERIFIER_ROLES.includes(role)) {
            return res.status(403).json({ error: 'Доступ запрещён' });
        }

        req.user = user;
        next();
    } catch (error) {
        console.error('requireVerifier error:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
}

async function checkBanned(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Login required' });

    const user = await db.get(
        'SELECT id, username, role, is_banned, ban_reason, banned_until FROM users WHERE id = ?',
        [req.user.id]
    );

    if (!user) return res.status(401).json({ error: 'User not found' });

    if (user.is_banned) {
        if (user.banned_until && new Date(user.banned_until) <= new Date()) {
            await db.run(
                'UPDATE users SET is_banned = 0, ban_reason = NULL, banned_until = NULL WHERE id = ?',
                [user.id]
            );
        } else {
            return res.status(403).json({
                error: 'Account banned',
                reason: user.ban_reason,
                until: user.banned_until
            });
        }
    }

    req.user = user;
    next();
}

// ============================================================
// Обновляем роль пользователя из БД на каждый запрос (если забанили
// или изменили роль — это применится сразу, без переlogin'а).
// Раньше этот же код был продублирован ещё раз внутри startServer() —
// убрал дубликат, оставил один экземпляр.
// ============================================================
app.use(async (req, res, next) => {
    if (req.session.user) {
        const freshUser = await db.get(
            'SELECT id, username, role, is_verified FROM users WHERE id = ?',
            [req.session.user.id]
        );
        if (freshUser) {
            req.session.user.role = freshUser.role;
            req.session.user.is_verified = !!freshUser.is_verified;
        }
    }
    req.user = req.session.user || null;
    next();
});

app.use('/submissions', express.static(path.join(__dirname, 'submissions')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/music', (req, res) => res.status(503).send('временно закрыто'));
app.get('/news', (req, res) => res.sendFile(path.join(__dirname, 'public', 'news.html')));
app.get('/auth', (req, res) => res.sendFile(path.join(__dirname, 'public', 'auth.html')));
app.get('/admin', requireModerator, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'public', 'profile.html')));
app.get('/collections', (req, res) => res.sendFile(path.join(__dirname, 'public', 'collections.html')));
app.get('/collection/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'collection.html')));

// ============================================================
// ✅ ИСПРАВЛЕНИЕ 1: загрузка видео в админку доступна ТОЛЬКО старшим
// модераторам (senior_moderator и admin). Используем requireVerifier вместо
// requireModerator — это гарантирует что только senior_moderator и admin
// смогут загружать видео.
// ============================================================
app.post('/admin/upload', requireVerifier, uploadVideo.single('videoFile'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
    res.json({ success: true, filename: req.file.filename });
});

// ============================================================
// СПИСОК ВИДЕО — теперь дополнительно возвращает данные автора
// (ник, роль, верификация, теги) для футажей, пришедших через
// одобренную заявку /api/submissions. Для видео, залитых напрямую
// через админку (/admin/upload), поле uploader будет null.
// ============================================================
app.get('/api/videos', (req, res) => {
    const videosDir = path.join(__dirname, 'videos');

    fs.readdir(videosDir, async (err, files) => {
        if (err) return res.status(500).json({ error: 'Не удалось прочитать папку' });

        try {
            const videoFiles = files
                .filter(file => ALLOWED_UPLOAD_EXTENSIONS.includes(path.extname(file).toLowerCase()))
                .map(file => ({
                    name: file,
                    time: fs.statSync(path.join(videosDir, file)).birthtimeMs
                }))
                .sort((a, b) => b.time - a.time)
                .map(f => f.name);

            const approvedSubs = await db.all(`
                SELECT s.final_filename AS filename, u.id AS user_id, u.username,
                       u.role, u.is_verified
                FROM submissions s
                JOIN users u ON u.id = s.user_id
                WHERE s.status = 'approved' AND s.final_filename IS NOT NULL
            `);

            const subByFile = new Map(approvedSubs.map(s => [s.filename, s]));

            const userIds = [...new Set(approvedSubs.map(s => s.user_id))];
            const tagsByUser = new Map();

            if (userIds.length) {
                const placeholders = userIds.map(() => '?').join(',');
                const tagRows = await db.all(`
                    SELECT ut.user_id, t.id, t.name, t.color, t.icon
                    FROM user_tags ut
                    JOIN tags t ON t.id = ut.tag_id
                    WHERE ut.user_id IN (${placeholders})
                    ORDER BY ut.assigned_at ASC
                `, userIds);

                tagRows.forEach(row => {
                    if (!tagsByUser.has(row.user_id)) tagsByUser.set(row.user_id, []);
                    tagsByUser.get(row.user_id).push({
                        id: row.id, name: row.name, color: row.color, icon: row.icon
                    });
                });
            }

            const result = videoFiles.map(name => {
                const sub = subByFile.get(name);
                const protocol = req.secure ? 'https' : 'http';  // ✅ ДОБАВЬТЕ
                const host = req.get('host');  // ✅ ДОБАВЬТЕ
                const baseUrl = `${protocol}://${host}`;  // ✅ ДОБАВЬТЕ

                return {
                    id: name.replace(/\.[^/.]+$/, ''),
                    name,
                    url: `${baseUrl}/videos/${encodeURIComponent(name)}`,  // ✅ ПОЛНЫЙ URL
                    uploader: sub ? {
                        username: sub.username,
                        role: sub.role,
                        is_verified: !!sub.is_verified,
                        tags: tagsByUser.get(sub.user_id) || []
                    } : null
                };
            });

            res.json(result);
        } catch (error) {
            console.error('Ошибка /api/videos:', error);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });
});

// ============================================================
// СПИСОК ВСЕХ ВИДЕО ДЛЯ АДМИНИСТРАТОРА
// Показывает все видео с инфо о размере, дате создания,
// количестве лайков, скачиваний и которого пользователя загрузил
// ============================================================
app.get('/api/admin/videos', requireAdmin, async (req, res) => {
    try {
        const videosDir = path.join(__dirname, 'videos');

        if (!fs.existsSync(videosDir)) {
            return res.json([]);
        }

        const files = fs.readdirSync(videosDir);
        const videoFiles = files.filter(file =>
            ALLOWED_UPLOAD_EXTENSIONS.includes(path.extname(file).toLowerCase())
        );

        const videoList = [];

        for (const filename of videoFiles) {
            const filepath = path.join(videosDir, filename);
            const stat = fs.statSync(filepath);

            // Получаем инфо об авторе из submissions
            const submission = await db.get(
                `SELECT s.id, s.user_id, s.display_name, s.created_at,
                        u.username, u.role, u.is_verified
                 FROM submissions s
                 JOIN users u ON u.id = s.user_id
                 WHERE s.final_filename = ?`,
                [filename]
            );

            // Считаем лайки и скачивания
            const likes = await db.get(
                'SELECT COUNT(*) as count FROM video_likes WHERE video_name = ?',
                [filename]
            );

            const downloads = await db.get(
                'SELECT count FROM video_downloads WHERE video_name = ?',
                [filename]
            );

            videoList.push({
                filename,
                display_name: submission?.display_name || filename,
                size: stat.size,
                created_at: stat.birthtimeMs,
                uploader: submission ? {
                    username: submission.username,
                    user_id: submission.user_id,
                    role: submission.role,
                    is_verified: !!submission.is_verified,
                    submission_id: submission.id,
                    submission_date: submission.created_at
                } : null,
                likes: likes?.count || 0,
                downloads: downloads?.count || 0
            });
        }

        // Сортируем по дате создания (новые первыми)
        videoList.sort((a, b) => b.created_at - a.created_at);

        res.json(videoList);
    } catch (error) {
        console.error('Error loading admin videos:', error);
        res.status(500).json({ error: 'Ошибка при загрузке видео' });
    }
});

// ============================================================
// УДАЛЕНИЕ ВИДЕО — только админ
// Удаляет видео файл и обновляет submissions если это одобренный футаж
// ============================================================
app.delete('/api/admin/videos/:filename', requireAdmin, async (req, res) => {
    try {
        const filename = decodeURIComponent(req.params.filename);

        // Безопасность: проверка пути
        if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
            return res.status(400).json({ error: 'Некорректное имя файла' });
        }

        // Проверка расширения
        if (!ALLOWED_UPLOAD_EXTENSIONS.includes(path.extname(filename).toLowerCase())) {
            return res.status(400).json({ error: 'Некорректный тип файла' });
        }

        const filepath = path.join(__dirname, 'videos', filename);

        // Проверка что файл точно в папке videos/
        if (!path.resolve(filepath).startsWith(path.resolve(path.join(__dirname, 'videos')))) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Проверка существования файла
        if (!fs.existsSync(filepath)) {
            return res.status(404).json({ error: 'Видео не найдено' });
        }

        // Удаляем файл с диска
        fs.unlinkSync(filepath);
        console.log(`[ADMIN] ${req.user.username} deleted video: ${filename}`);

        // Обновляем submissions если это одобренный футаж
        // (меняем статус на 'deleted' или удаляем final_filename)
        await db.run(
            `UPDATE submissions SET final_filename = NULL WHERE final_filename = ?`,
            [filename]
        );

        // Удаляем все лайки и скачивания этого видео
        await db.run('DELETE FROM video_likes WHERE video_name = ?', [filename]);
        await db.run('DELETE FROM video_downloads WHERE video_name = ?', [filename]);

        // Удаляем видео из всех коллекций
        await db.run('DELETE FROM collection_items WHERE video_name = ?', [filename]);

        res.json({ success: true, message: 'Видео удалено' });
    } catch (error) {
        console.error('Error deleting video:', error);
        res.status(500).json({ error: 'Ошибка при удалении видео' });
    }
});

// ============================================================
// ПЕРЕИМЕНОВАНИЕ ВИДЕО — только админ
// Меняет имя файла видео и обновляет все связи в БД
// ============================================================
app.post('/api/admin/videos/:filename/rename', requireAdmin, async (req, res) => {
    try {
        const oldFilename = decodeURIComponent(req.params.filename);
        const { new_name } = req.body;

        // Безопасность: проверка старого имени
        if (!oldFilename || oldFilename.includes('..') || oldFilename.includes('/') || oldFilename.includes('\\')) {
            return res.status(400).json({ error: 'Некорректное имя файла' });
        }

        // Безопасность: проверка расширения
        if (!ALLOWED_UPLOAD_EXTENSIONS.includes(path.extname(oldFilename).toLowerCase())) {
            return res.status(400).json({ error: 'Некорректный тип файла' });
        }

        // Проверка нового имени
        if (!new_name || typeof new_name !== 'string' || !new_name.trim()) {
            return res.status(400).json({ error: 'Укажите новое имя' });
        }

        // Сохраняем расширение файла
        const ext = path.extname(oldFilename);

        // Очищаем имя (удаляем опасные символы)
        let cleanName = String(new_name).trim()
            .replace(/[/\\?%*:|"<>;&#]/g, '')
            .slice(0, 100);

        if (!cleanName) {
            return res.status(400).json({ error: 'Имя файла не может быть пустым' });
        }

        const newFilename = cleanName + ext;

        // Проверка что новое имя не совпадает со старым
        if (newFilename === oldFilename) {
            return res.json({ success: true, message: 'Имя не изменилось' });
        }

        const oldPath = path.join(__dirname, 'videos', oldFilename);
        const newPath = path.join(__dirname, 'videos', newFilename);

        // Проверка что файлы точно в папке videos/
        if (!path.resolve(oldPath).startsWith(path.resolve(path.join(__dirname, 'videos'))) ||
            !path.resolve(newPath).startsWith(path.resolve(path.join(__dirname, 'videos')))) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Проверка что старый файл существует
        if (!fs.existsSync(oldPath)) {
            return res.status(404).json({ error: 'Видео не найдено' });
        }

        // Проверка что новое имя уже не занято
        if (fs.existsSync(newPath)) {
            return res.status(400).json({ error: 'Файл с таким именем уже существует' });
        }

        // Переименовываем файл
        fs.renameSync(oldPath, newPath);
        console.log(`[ADMIN] ${req.user.username} renamed video: ${oldFilename} -> ${newFilename}`);

        // Обновляем БД — все ссылки на старое имя меняем на новое
        // 1. Обновляем submissions (final_filename)
        await db.run(
            'UPDATE submissions SET final_filename = ? WHERE final_filename = ?',
            [newFilename, oldFilename]
        );

        // 2. Обновляем video_likes
        await db.run(
            'UPDATE video_likes SET video_name = ? WHERE video_name = ?',
            [newFilename, oldFilename]
        );

        // 3. Обновляем video_downloads
        await db.run(
            'UPDATE video_downloads SET video_name = ? WHERE video_name = ?',
            [newFilename, oldFilename]
        );

        // 4. Обновляем collection_items
        await db.run(
            'UPDATE collection_items SET video_name = ? WHERE video_name = ?',
            [newFilename, oldFilename]
        );

        res.json({ success: true, message: 'Видео переименовано', new_filename: newFilename });
    } catch (error) {
        console.error('Error renaming video:', error);
        res.status(500).json({ error: 'Ошибка при переименовании видео' });
    }
});

app.get('/api/tracks', (req, res) => {
    try {
        const files = fs.readdirSync(SOUNDS_DIR);
        const audioFiles = files
            .filter(file => ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'].includes(path.extname(file).toLowerCase()))
            .sort();

        const tracks = audioFiles.map((file, index) => ({
            id: index,
            name: path.basename(file, path.extname(file)),
            filename: file,
            url: `/api/stream/${encodeURIComponent(file)}`,
            ext: path.extname(file).toLowerCase()
        }));

        res.json({ success: true, count: tracks.length, tracks });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 'Failed to read tracks' });
    }
});

app.get('/api/stream/:filename', (req, res) => {
    try {
        const filename = decodeURIComponent(req.params.filename);
        const filepath = path.join(SOUNDS_DIR, filename);

        if (!path.resolve(filepath).startsWith(path.resolve(SOUNDS_DIR))) {
            return res.status(403).json({ error: 'Access denied' });
        }

        if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Track not found' });

        const stat = fs.statSync(filepath);
        const fileSize = stat.size;
        const range = req.headers.range;

        const mimeTypes = {
            '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
            '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.aac': 'audio/aac'
        };
        const contentType = mimeTypes[path.extname(filename).toLowerCase()] || 'audio/mpeg';

        if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunksize = (end - start) + 1;
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=3600'
            });
            fs.createReadStream(filepath, { start, end }).pipe(res);
        } else {
            res.writeHead(200, {
                'Content-Length': fileSize,
                'Content-Type': contentType,
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'public, max-age=3600'
            });
            fs.createReadStream(filepath).pipe(res);
        }
    } catch (error) {
        console.error('Ошибка стрима:', error);
        res.status(500).json({ error: 'Failed to stream track' });
    }
});

app.get('/api/likes/:videoName', async (req, res) => {
    const { videoName } = req.params;
    const userId = req.session.user?.id || null;

    const count = await db.get('SELECT COUNT(*) as total FROM video_likes WHERE video_name = ?', [videoName]);

    let liked = false;
    if (userId) {
        const row = await db.get(
            'SELECT id FROM video_likes WHERE user_id = ? AND video_name = ?', [userId, videoName]
        );
        liked = !!row;
    }

    res.json({ likes: count.total, liked });
});

app.post('/api/likes/:videoName', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Нужно войти' });

    const { videoName } = req.params;
    const userId = req.session.user.id;

    const existing = await db.get(
        'SELECT id FROM video_likes WHERE user_id = ? AND video_name = ?', [userId, videoName]
    );

    if (existing) {
        await db.run('DELETE FROM video_likes WHERE user_id = ? AND video_name = ?', [userId, videoName]);
        res.json({ liked: false });
    } else {
        await db.run('INSERT INTO video_likes (user_id, video_name) VALUES (?, ?)', [userId, videoName]);
        res.json({ liked: true });
    }
});

app.post('/api/downloads/:videoName', async (req, res) => {
    const { videoName } = req.params;
    const userId = req.session.user?.id;

    await db.run(
        'INSERT INTO video_downloads (video_name, count) VALUES (?, 1) ON CONFLICT(video_name) DO UPDATE SET count = count + 1',
        [videoName]
    );

    if (userId) {
        await db.run(
            'INSERT INTO user_points (user_id, points) VALUES (?, 1) ON CONFLICT(user_id) DO UPDATE SET points = points + 1',
            [userId]
        );
    }

    res.json({ success: true });
});

app.get('/api/downloads/:videoName', async (req, res) => {
    const { videoName } = req.params;
    const row = await db.get('SELECT count FROM video_downloads WHERE video_name = ?', [videoName]);
    res.json({ downloads: row?.count || 0 });
});


// Публичный профиль по username
app.get('/user/:username', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'user.html'));
});

// API — данные публичного профиля (теперь включает теги пользователя)
app.get('/api/user/:username', async (req, res) => {
    const { username } = req.params;

    const user = await db.get(
        'SELECT id, username, role, is_verified FROM users WHERE username = ?',
        [username]
    );

    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    const points = await db.get(
        'SELECT points FROM user_points WHERE user_id = ?', [user.id]
    );
    const collections = await db.all(
        'SELECT id, name, description, is_public FROM collections WHERE user_id = ? AND is_public = 1',
        [user.id]
    );
    const likesCount = await db.get(
        'SELECT COUNT(*) as total FROM video_likes WHERE user_id = ?', [user.id]
    );

    // Теги, выданные этому пользователю
    const tags = await db.all(`
        SELECT t.id, t.name, t.color, t.icon
        FROM user_tags ut
        JOIN tags t ON t.id = ut.tag_id
        WHERE ut.user_id = ?
        ORDER BY ut.assigned_at ASC
    `, [user.id]);

    res.json({
        username: user.username,
        role: user.role,
        is_verified: !!user.is_verified,
        points: points?.points || 0,
        public_collections: collections,
        likes_count: likesCount.total,
        tags
    });
});

// ============================================================
// СОЗДАНИЕ КОЛЛЕКЦИИ — добавлен лимит MAX_COLLECTIONS_PER_USER (6)
// и обрезка длины полей name/description, чтобы никто не мог
// забить базу гигантскими строками.
// ============================================================
app.post('/api/collections', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Нужно войти' });

    const { name, description, is_public } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Нужно название' });

    const cleanName = sanitizeInput(String(name).trim().slice(0, 60));
    const cleanDescription = sanitizeInput(String(description || '').slice(0, 300));

    // --- ЛИМИТ КОЛЛЕКЦИЙ ---
    const existingCount = await db.get(
        'SELECT COUNT(*) as total FROM collections WHERE user_id = ?',
        [req.session.user.id]
    );

    if (existingCount.total >= MAX_COLLECTIONS_PER_USER) {
        return res.status(400).json({
            error: `Достигнут лимит коллекций (${MAX_COLLECTIONS_PER_USER}). Удалите старую коллекцию, чтобы создать новую.`
        });
    }

    const date = new Date().toISOString();
    const result = await db.run(
        'INSERT INTO collections (user_id, name, description, is_public, created_at) VALUES (?, ?, ?, ?, ?)',
        [req.session.user.id, cleanName, cleanDescription, is_public ? 1 : 0, date]
    );

    res.json({ success: true, id: result.lastID });
});

app.get('/api/collections/my', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Нужно войти' });

    const cols = await db.all(
        'SELECT * FROM collections WHERE user_id = ? ORDER BY id DESC', [req.session.user.id]
    );

    for (const col of cols) {
        col.items = await db.all('SELECT video_name FROM collection_items WHERE collection_id = ?', [col.id]);
    }

    res.json(cols);
});

app.get('/api/collections/:id', async (req, res) => {
    const col = await db.get('SELECT * FROM collections WHERE id = ?', [req.params.id]);
    if (!col) return res.status(404).json({ error: 'Не найдено' });
    if (!col.is_public && req.session.user?.id !== col.user_id) {
        return res.status(403).json({ error: 'Приватная коллекция' });
    }

    col.items = await db.all('SELECT video_name FROM collection_items WHERE collection_id = ?', [col.id]);
    const author = await db.get('SELECT username FROM users WHERE id = ?', [col.user_id]);
    col.author = author?.username || 'unknown';

    res.json(col);
});

// ============================================================
// ДОБАВЛЕНИЕ ВИДЕО В КОЛЛЕКЦИЮ — раньше video_name из тела запроса
// сохранялся в базу вообще без проверки, что такой файл существует
// и что это просто имя файла, а не путь с "../". Теперь:
//  1) берём только basename() — убираем любые "/" и "\" из имени;
//  2) проверяем, что после этого имя не изменилось (иначе — там был путь);
//  3) проверяем, что файл реально существует в папке videos/.
// ============================================================
app.post('/api/collections/:id/items', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Нужно войти' });

    const col = await db.get('SELECT * FROM collections WHERE id = ?', [req.params.id]);
    if (!col || col.user_id !== req.session.user.id) return res.status(403).json({ error: 'Нет доступа' });

    const { video_name } = req.body;
    if (!video_name || typeof video_name !== 'string') {
        return res.status(400).json({ error: 'Некорректное имя видео' });
    }

    const safeVideoName = path.basename(video_name);
    if (safeVideoName !== video_name) {
        return res.status(400).json({ error: 'Некорректное имя видео' });
    }

    const videoPath = path.join(__dirname, 'videos', safeVideoName);
    if (!fs.existsSync(videoPath)) {
        return res.status(404).json({ error: 'Такого видео не существует' });
    }

    const date = new Date().toISOString();

    try {
        await db.run(
            'INSERT INTO collection_items (collection_id, video_name, added_at) VALUES (?, ?, ?)',
            [col.id, safeVideoName, date]
        );
        res.json({ success: true });
    } catch {
        res.status(400).json({ error: 'Уже в коллекции' });
    }
});

app.delete('/api/collections/:id/items', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Нужно войти' });

    const col = await db.get('SELECT * FROM collections WHERE id = ?', [req.params.id]);
    if (!col || col.user_id !== req.session.user.id) return res.status(403).json({ error: 'Нет доступа' });

    await db.run(
        'DELETE FROM collection_items WHERE collection_id = ? AND video_name = ?',
        [req.params.id, req.body.video_name]
    );
    res.json({ success: true });
});

// ============================================================
// ✅ ИСПРАВЛЕНИЕ 2: удаление коллекций пользователем доступно только
// старшим модераторам (senior_moderator и admin). Используем requireVerifier
// чтобы добавить дополнительную проверку.
// ============================================================
app.delete('/api/collections/:id', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Нужно войти' });

    const col = await db.get('SELECT * FROM collections WHERE id = ?', [req.params.id]);
    if (!col) return res.status(404).json({ error: 'Коллекция не найдена' });

    // Пользователь может удалить только свою коллекцию
    if (col.user_id !== req.session.user.id) {
        return res.status(403).json({ error: 'Нет доступа' });
    }

    // Проверяем что это старший модератор или админ
    const user = await db.get(
        'SELECT id, role FROM users WHERE id = ?',
        [req.session.user.id]
    );

    if (!user) return res.status(401).json({ error: 'Пользователь не найден' });

    const role = String(user.role || '').trim().toLowerCase();
    // VERIFIER_ROLES = ['admin', 'senior_moderator']
    if (!VERIFIER_ROLES.includes(role)) {
        return res.status(403).json({
            error: 'Удалять коллекции могут только старшие модераторы и администраторы'
        });
    }

    await db.run('DELETE FROM collection_items WHERE collection_id = ?', [req.params.id]);
    await db.run('DELETE FROM collections WHERE id = ?', [req.params.id]);
    res.json({ success: true });
});

app.get('/api/profile', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Нужно войти' });

    const userId = req.session.user.id;
    const points = await db.get('SELECT points FROM user_points WHERE user_id = ?', [userId]);
    const likes = await db.all('SELECT video_name FROM video_likes WHERE user_id = ?', [userId]);
    const collections = await db.all('SELECT id, name, is_public FROM collections WHERE user_id = ?', [userId]);

    res.json({
        username: req.session.user.username,
        role: req.session.user.role,
        is_verified: !!req.session.user.is_verified,
        telegram_linked: !!req.session.user.telegram_linked,
        points: points?.points || 0,
        liked_videos: likes.map(l => l.video_name),
        collections
    });
});

// ============================================================
// РЕГИСТРАЦИЯ / ЛОГИН — теперь под строгим authLimiter (10 попыток / 15 мин)
//
// НОВОЕ: регистрация обязательно проходит через Telegram-бота:
//   1) /api/register/start   — принимает логин/пароль/telegram ID,
//      проверяет их, шлёт код подтверждения в бота, кладёт
//      "заявку" во временное хранилище (сессия), но аккаунт ЕЩЁ
//      НЕ создаёт.
//   2) /api/register/confirm — принимает код, если всё верно —
//      создаёт аккаунт СРАЗУ с привязанным telegram_id.
//
// Для входа: если у аккаунта уже есть привязанный Telegram —
// после верного пароля код подтверждения уходит в бота, и логин
// завершается только через /api/login/confirm. Если Telegram не
// привязан — вход как раньше, в один шаг (см. флаг telegram_linked
// в ответе — по нему фронт показывает баннер "привяжи Telegram").
// ============================================================

const REGISTER_CODE_TTL_MS = 10 * 60 * 1000; // 10 минут на ввод кода регистрации
const LOGIN_CODE_TTL_MS = 5 * 60 * 1000;     // 5 минут на ввод кода входа
const USERNAME_REGEX = /^[a-zA-Z0-9_\-]{3,15}$/;
const TELEGRAM_ID_REGEX = /^\d{5,15}$/;

// ============================================================
// ЗАРЕЗЕРВИРОВАННЫЕ ЛОГИНЫ — раньше роль admin выдавалась по имени
// пользователя ('Admin', 'Moder') при КАЖДОМ старте сервера. Это
// значило, что: 1) любой мог зарегистрироваться под этим логином
// раньше настоящего админа и после рестарта сервера сам стать
// админом; 2) если админ переименует себя или удалит аккаунт, его
// логин снова становится «свободным» для захвата. Теперь такие
// логины просто запрещены к регистрации, а назначение роли admin
// делается вручную напрямую в БД (см. README/скрипт миграции),
// а не автоматически при каждом запуске.
// ============================================================
const RESERVED_USERNAMES = ['admin', 'moder', 'moderator', 'root', 'system', 'support'];

function generateSixDigitCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Шаг 1 регистрации: проверяем данные, шлём код в Telegram, ничего не пишем в users
app.post('/api/register/start', authLimiter, async (req, res) => {
    const { username, password } = req.body;
    const telegramId = String(req.body.telegramId || '').trim();

    if (!username || !password || !telegramId)
        return res.status(400).json({ error: 'Заполните все поля!' });

    if (!USERNAME_REGEX.test(username)) {
        return res.status(400).json({
            error: 'Логин: только латинские буквы, цифры, _ и -. От 3 до 15 символов, без пробелов.'
        });
    }

    if (RESERVED_USERNAMES.includes(username.trim().toLowerCase())) {
        return res.status(400).json({ error: 'Этот логин зарезервирован и недоступен для регистрации.' });
    }

    if (password.length < 6)
        return res.status(400).json({ error: 'Пароль минимум 6 символов' });

    if (!TELEGRAM_ID_REGEX.test(telegramId)) {
        return res.status(400).json({ error: 'Некорректный Telegram ID. Получи его в боте по команде /start.' });
    }

    try {
        const existingUsername = await db.get('SELECT id FROM users WHERE username = ?', [username]);
        if (existingUsername) return res.status(400).json({ error: 'Пользователь с таким логином уже существует!' });

        const existingTelegram = await db.get('SELECT id FROM users WHERE telegram_id = ?', [telegramId]);
        if (existingTelegram) return res.status(400).json({ error: 'Этот Telegram уже привязан к другому аккаунту!' });

        const passwordHash = await bcrypt.hash(password, 10);
        const code = generateSixDigitCode();

        req.session.pendingRegister = {
            username,
            passwordHash,
            telegramId,
            code,
            expiresAt: Date.now() + REGISTER_CODE_TTL_MS
        };

        await queueNotification({ type: 'register_code', targetChatId: telegramId, message: code });

        req.session.save((err) => {
            if (err) {
                console.error('Session save error (register/start):', err);
                return res.status(500).json({ error: 'Ошибка сервера' });
            }
            res.json({ success: true, message: 'Код отправлен в Telegram' });
        });
    } catch (err) {
        console.error('register/start error:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Шаг 2 регистрации: проверяем код, только теперь создаём аккаунт
app.post('/api/register/confirm', authLimiter, async (req, res) => {
    const { code } = req.body;
    const pending = req.session.pendingRegister;

    if (!pending) return res.status(400).json({ error: 'Сначала запросите код регистрации.' });
    if (!code) return res.status(400).json({ error: 'Введите код из Telegram.' });
    if (Date.now() > pending.expiresAt) {
        delete req.session.pendingRegister;
        return res.status(400).json({ error: 'Код истёк. Начните регистрацию заново.' });
    }
    if (String(code).trim() !== pending.code) {
        return res.status(400).json({ error: 'Неверный код подтверждения.' });
    }

    try {
        // На случай, если логин/Telegram ID заняли, пока ждали код
        const existingUsername = await db.get('SELECT id FROM users WHERE username = ?', [pending.username]);
        if (existingUsername) {
            delete req.session.pendingRegister;
            return res.status(400).json({ error: 'Пользователь с таким логином уже существует!' });
        }
        const existingTelegram = await db.get('SELECT id FROM users WHERE telegram_id = ?', [pending.telegramId]);
        if (existingTelegram) {
            delete req.session.pendingRegister;
            return res.status(400).json({ error: 'Этот Telegram уже привязан к другому аккаунту!' });
        }

        // Если пользователь уже писал боту — подхватим его telegram-ник
        let telegramUsername = null;
        try {
            const tu = await db.get('SELECT telegram_username FROM telegram_users WHERE telegram_id = ?', [pending.telegramId]);
            telegramUsername = tu?.telegram_username || null;
        } catch { }

        const result = await db.run(
            'INSERT INTO users (username, password, role, telegram_id, telegram_username) VALUES (?, ?, ?, ?, ?)',
            [pending.username, pending.passwordHash, 'user', pending.telegramId, telegramUsername]
        );

        try {
            await db.run(
                `INSERT INTO telegram_users (telegram_id, telegram_username, user_id, first_seen, last_seen)
                 VALUES (?, ?, ?, datetime('now'), datetime('now'))
                 ON CONFLICT(telegram_id) DO UPDATE SET user_id = excluded.user_id, last_seen = datetime('now')`,
                [pending.telegramId, telegramUsername, result.lastID]
            );
        } catch (e) { console.error('telegram_users upsert error:', e); }

        delete req.session.pendingRegister;
        res.json({ success: true, message: 'Регистрация успешна! Аккаунт привязан к Telegram.' });
    } catch (err) {
        console.error('register/confirm error:', err);
        res.status(400).json({ error: 'Пользователь с таким логином уже существует!' });
    }
});

app.post('/api/login', authLimiter, async (req, res) => {
    const { username, password } = req.body;

    try {
        const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
        if (!user) return res.status(400).json({ error: 'Неверный логин или пароль!' });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ error: 'Неверный логин или пароль!' });

        if (user.is_banned) {
            if (!user.banned_until || new Date(user.banned_until) > new Date()) {
                return res.status(403).json({
                    error: 'Аккаунт заблокирован',
                    reason: user.ban_reason,
                    until: user.banned_until
                });
            }
        }

        // Если у аккаунта привязан Telegram — пароль верный, но вход
        // завершится только после ввода кода из бота (2FA).
        if (user.telegram_id) {
            const code = generateSixDigitCode();
            req.session.pendingLogin = {
                userId: user.id,
                code,
                expiresAt: Date.now() + LOGIN_CODE_TTL_MS
            };
            await queueNotification({ type: 'login_code', targetChatId: user.telegram_id, message: code });
            return req.session.save((err) => {
                if (err) {
                    console.error('Session save error (login pending):', err);
                    return res.status(500).json({ error: 'Ошибка сервера при входе' });
                }
                res.json({ success: true, requires2fa: true, message: 'Код отправлен в Telegram' });
            });
        }

        // Регенерируем session ID при логине — защита от session fixation
        // (без этого атакующий мог бы заранее "подсунуть" жертве известный
        // ему session ID и после логина жертвы получить доступ к её сессии).
        req.session.regenerate((err) => {
            if (err) {
                console.error('Session regenerate error:', err);
                return res.status(500).json({ error: 'Ошибка сервера при входе' });
            }
            req.session.user = {
                id: user.id,
                username: user.username,
                role: user.role,
                is_verified: !!user.is_verified,
                telegram_linked: false
            };
            res.json({ success: true, user: req.session.user });
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка сервера при входе' });
    }
});

// Шаг 2 входа: проверка кода из Telegram (для аккаунтов с привязанным ботом)
app.post('/api/login/confirm', authLimiter, async (req, res) => {
    const { code } = req.body;
    const pending = req.session.pendingLogin;

    if (!pending) return res.status(400).json({ error: 'Сначала введите логин и пароль.' });
    if (!code) return res.status(400).json({ error: 'Введите код из Telegram.' });
    if (Date.now() > pending.expiresAt) {
        delete req.session.pendingLogin;
        return res.status(400).json({ error: 'Код истёк. Попробуйте войти заново.' });
    }
    if (String(code).trim() !== pending.code) {
        return res.status(400).json({ error: 'Неверный код подтверждения.' });
    }

    try {
        const user = await db.get('SELECT * FROM users WHERE id = ?', [pending.userId]);
        if (!user) { delete req.session.pendingLogin; return res.status(400).json({ error: 'Аккаунт не найден.' }); }

        if (user.is_banned) {
            if (!user.banned_until || new Date(user.banned_until) > new Date()) {
                delete req.session.pendingLogin;
                return res.status(403).json({ error: 'Аккаунт заблокирован', reason: user.ban_reason, until: user.banned_until });
            }
        }

        delete req.session.pendingLogin;

        req.session.regenerate((err) => {
            if (err) {
                console.error('Session regenerate error (login confirm):', err);
                return res.status(500).json({ error: 'Ошибка сервера при входе' });
            }
            req.session.user = {
                id: user.id,
                username: user.username,
                role: user.role,
                is_verified: !!user.is_verified,
                telegram_linked: true
            };
            res.json({ success: true, user: req.session.user });
        });
    } catch (err) {
        console.error('login/confirm error:', err);
        res.status(500).json({ error: 'Ошибка сервера при входе' });
    }
});

app.get('/api/me', (req, res) => {
    if (req.session.user) {
        res.json({ loggedIn: true, user: req.session.user });
    } else {
        res.json({ loggedIn: false });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/news', async (req, res) => {
    try {
        const news = await db.all('SELECT * FROM news ORDER BY id DESC');
        res.json(news);
    } catch (err) {
        res.status(500).json({ error: 'Не удалось загрузить новости' });
    }
});

app.post('/api/news', requireAdmin, uploadNews.single('image'), async (req, res) => {
    const { title, content } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'Заполните все поля!' });

    const cleanTitle = sanitizeInput(String(title).slice(0, 200));
    const cleanContent = sanitizeInput(String(content).slice(0, 20000));

    const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

    try {
        const date = new Date().toLocaleDateString('ru-RU', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });

        await db.run(
            'INSERT INTO news (title, content, image, date) VALUES (?, ?, ?, ?)',
            [cleanTitle, cleanContent, imageUrl, date]
        );

        // 🔔 Уведомляем в Telegram всех, кто привязал аккаунт — с картинкой,
        // если она была прикреплена к новости
        await queueNotification({
            type: 'broadcast_news',
            title: cleanTitle,
            message: cleanContent,
            imagePath: imageUrl
        });

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Ошибка при сохранении новости' });
    }
});
const submissionsDir = path.join(__dirname, 'submissions');
if (!fs.existsSync(submissionsDir)) fs.mkdirSync(submissionsDir);

const submissionStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, submissionsDir),
    filename: (req, file, cb) => {
        // ============================================================
        // ✅ ИСПРАВЛЕНИЕ: раньше это обращалось к req.session.user.id без
        // проверки, что пользователь вообще авторизован. Если прислать
        // multipart-запрос с файлом без сессии, req.session.user был
        // undefined, и .id кидал TypeError прямо внутри callback'а
        // multer'а — до того, как хендлер роута успевал проверить auth.
        // Необработанное исключение здесь могло уронить процесс целиком
        // (DoS одним неавторизованным запросом). Теперь при отсутствии
        // сессии просто отклоняем файл через cb(error) — сам хендлер
        // роута ниже всё равно ещё раз явно проверяет req.session.user
        // и вернёт корректный 401.
        // ============================================================
        if (!req.session || !req.session.user || !req.session.user.id) {
            return cb(new Error('Нужно войти для отправки файла'));
        }

        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `sub_${Date.now()}_${req.session.user.id}${ext}`);
    }
});

const submissionUpload = multer({
    storage: submissionStorage,
    limits: { fileSize: 7 * 1024 * 1024 }, // 7MB
    fileFilter: (req, file, cb) => {
        const allowed = ['.mp4', '.mkv', '.webm', '.mov'];
        if (allowed.includes(path.extname(file.originalname).toLowerCase())) {
            cb(null, true);
        } else {
            cb(new Error('Только видео файлы'), false);
        }
    }
});

// Отправить футаж на модерацию
app.post('/api/submissions',
    // ============================================================
    // ✅ Проверяем авторизацию ДО того, как multer вообще начнёт
    // парсить файл — раньше эта проверка была только внутри хендлера,
    // уже после того, как submissionStorage.filename() пытался
    // прочитать req.session.user.id и падал с TypeError на
    // неавторизованных запросах (см. комментарий выше).
    // ============================================================
    (req, res, next) => {
        if (!req.session?.user) {
            return res.status(401).json({ error: 'Нужно войти' });
        }
        next();
    },
    (req, res, next) => {
        submissionUpload.single('video')(req, res, (err) => {
            if (err) {
                return res.status(400).json({ error: err.message || 'Ошибка загрузки файла' });
            }
            next();
        });
    },
    async (req, res) => {
    try {
        console.log('SUBMISSION:', {
            user: req.session?.user,
            file: req.file,
            body: req.body
        });

        if (!req.session?.user) {
            return res.status(401).json({ error: 'Нужно войти' });
        }

        const userId = req.session.user.id;

        const userDb = await db.get(
            'SELECT is_banned, ban_reason FROM users WHERE id = ?',
            [userId]
        );

        if (userDb?.is_banned) {
            if (req.file?.path) {
                fs.unlink(req.file.path, () => { });
            }

            return res.status(403).json({
                error: 'Твой аккаунт заблокирован'
            });
        }

        const displayName = sanitizeInput((req.body.display_name || '').trim()).slice(0, 100);

        if (!displayName) {
            if (req.file?.path) {
                fs.unlink(req.file.path, () => { });
            }

            return res.status(400).json({
                error: 'Укажи название футажа'
            });
        }

        if (!req.file) {
            return res.status(400).json({
                error: 'Файл не получен'
            });
        }

        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const count = await db.get(
            `SELECT COUNT(*) AS total
             FROM submissions
             WHERE user_id = ?
             AND created_at >= ?`,
            [userId, todayStart.toISOString()]
        );

        console.log('UPLOAD COUNT:', count);

        if (count.total >= 5) {
            fs.unlink(req.file.path, () => { });

            return res.status(400).json({
                error: 'Макс 5 футажей в день'
            });
        }

        await db.run(
            `INSERT INTO submissions
             (user_id, filename, display_name, status, created_at)
             VALUES (?, ?, ?, 'pending', ?)`,
            [
                userId,
                req.file.filename,
                displayName,
                new Date().toISOString()
            ]
        );

        console.log('SUBMISSION INSERTED');

        return res.json({ success: true });

    } catch (err) {
        console.error('SUBMISSION ERROR:', err);

        return res.status(500).json({
            error: 'Ошибка сервера',
            details: process.env.NODE_ENV !== 'production'
                ? err.message
                : undefined
        });
    }
});


// Мои отправленные футажи
app.get('/api/submissions/my', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Нужно войти' });

    const subs = await db.all(
        `SELECT id, display_name, status, created_at FROM submissions WHERE user_id = ? ORDER BY id DESC`,
        [req.session.user.id]
    );
    res.json(subs);
});

// Все заявки для модератора
app.get('/api/admin/submissions', requireModerator, async (req, res) => {
    const subs = await db.all(`
        SELECT s.id, s.filename, s.display_name, s.status, s.created_at,
               u.username
        FROM submissions s
        JOIN users u ON u.id = s.user_id
        WHERE s.status = 'pending'
        ORDER BY s.id ASC
    `);
    res.json(subs);
});

// Одобрить — переименовать и переместить в videos/
app.post('/api/admin/submissions/:id/approve', requireModerator, async (req, res) => {
    const sub = await db.get('SELECT * FROM submissions WHERE id = ?', [req.params.id]);
    if (!sub) return res.status(404).json({ error: 'Не найдено' });

    const newName = sanitizeInput((req.body.display_name || sub.display_name).trim()).slice(0, 100);
    const ext = path.extname(sub.filename);
    const finalName = newName.replace(/[^a-zA-ZА-Яа-яЁёІіЇїЄєҐґ0-9_\-\s]/g, '').trim() + ext;

    const from = path.join(__dirname, 'submissions', sub.filename);
    const to = path.join(__dirname, 'videos', finalName);

    fs.rename(from, to, async (err) => {
        if (err) return res.status(500).json({ error: 'Ошибка перемещения файла' });

        await db.run(
            `UPDATE submissions SET status = 'approved', display_name = ?, final_filename = ? WHERE id = ?`,
            [newName, finalName, sub.id]
        );

        // 🔔 Ссылка на футаж для уведомлений в Telegram
        const videoLink = `${SITE_URL}/videos/${encodeURIComponent(finalName)}`;

        // Всем, кто привязал Telegram — анонс нового футажа на сайте
        await queueNotification({
            type: 'broadcast_footage',
            title: newName,
            link: videoLink
        });

        // Автору заявки — что его футаж одобрили (уйдёт, только если у него привязан Telegram)
        await queueNotification({
            type: 'personal_approved',
            targetUserId: sub.user_id,
            title: newName,
            link: videoLink
        });

        res.json({ success: true });
    });
});

// Отклонить
app.post('/api/admin/submissions/:id/reject', requireModerator, async (req, res) => {
    const sub = await db.get('SELECT * FROM submissions WHERE id = ?', [req.params.id]);
    if (!sub) return res.status(404).json({ error: 'Не найдено' });

    fs.unlink(path.join(__dirname, 'submissions', sub.filename), () => { });
    await db.run(`UPDATE submissions SET status = 'rejected' WHERE id = ?`, [sub.id]);

    // 🔔 Автору заявки — что его футаж отклонили (уйдёт, только если у него привязан Telegram)
    await queueNotification({
        type: 'personal_rejected',
        targetUserId: sub.user_id,
        title: (sub.display_name || '').trim()
    });

    res.json({ success: true });
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
    const userId = Number(req.params.id);

    const user = await db.get('SELECT id, role FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (user.role === 'admin') return res.status(403).json({ error: 'Нельзя удалить администратора' });

    await db.run('DELETE FROM video_likes WHERE user_id = ?', [userId]);
    await db.run('DELETE FROM user_points WHERE user_id = ?', [userId]);
    await db.run('DELETE FROM collection_items WHERE collection_id IN (SELECT id FROM collections WHERE user_id = ?)', [userId]);
    await db.run('DELETE FROM collections WHERE user_id = ?', [userId]);
    await db.run('DELETE FROM submissions WHERE user_id = ?', [userId]);
    await db.run('DELETE FROM user_tags WHERE user_id = ?', [userId]); // не забываем убрать выданные теги
    await db.run('DELETE FROM users WHERE id = ?', [userId]);

    res.json({ success: true });
});

// Страница отправки
app.get('/submit', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'submit.html'));
});

app.get('/api/admin/users', requireModerator, async (req, res) => {
    try {
        const users = await db.all(
            'SELECT id, username, role, is_banned, ban_reason, banned_until, is_verified FROM users ORDER BY id DESC'
        );
        res.json(users);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to load users' });
    }
});

app.post('/api/admin/users/:id/moderator', requireAdmin, async (req, res) => {
    try {
        const userId = Number(req.params.id);
        const user = await db.get('SELECT id, username, role FROM users WHERE id = ?', [userId]);

        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.role === 'admin') return res.status(400).json({ error: 'Administrator cannot be moderator' });

        await db.run('UPDATE users SET role = ? WHERE id = ?', ['moderator', userId]);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to make moderator' });
    }
});

app.delete('/api/admin/users/:id/moderator', requireAdmin, async (req, res) => {
    try {
        const userId = Number(req.params.id);
        await db.run("UPDATE users SET role = 'user' WHERE id = ? AND role = 'moderator'", [userId]);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to remove moderator' });
    }
});

// ============================================================
// МЛ. МОДЕРАТОР — базовые права модератора + может выдавать теги.
// Назначать/снимать может только админ.
// ============================================================
app.post('/api/admin/users/:id/junior-moderator', requireAdmin, async (req, res) => {
    try {
        const userId = Number(req.params.id);
        const user = await db.get('SELECT id, role FROM users WHERE id = ?', [userId]);

        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.role === 'admin') return res.status(400).json({ error: 'Administrator cannot be moderator' });

        await db.run('UPDATE users SET role = ? WHERE id = ?', ['junior_moderator', userId]);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to make junior moderator' });
    }
});

app.delete('/api/admin/users/:id/junior-moderator', requireAdmin, async (req, res) => {
    try {
        const userId = Number(req.params.id);
        await db.run("UPDATE users SET role = 'user' WHERE id = ? AND role = 'junior_moderator'", [userId]);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to remove junior moderator' });
    }
});

// ============================================================
// СТ. МОДЕРАТОР — базовые права модератора + может выдавать
// верификацию (синюю галочку). Назначать/снимать может только админ.
// ============================================================
app.post('/api/admin/users/:id/senior-moderator', requireAdmin, async (req, res) => {
    try {
        const userId = Number(req.params.id);
        const user = await db.get('SELECT id, role FROM users WHERE id = ?', [userId]);

        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.role === 'admin') return res.status(400).json({ error: 'Administrator cannot be moderator' });

        await db.run('UPDATE users SET role = ? WHERE id = ?', ['senior_moderator', userId]);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to make senior moderator' });
    }
});

app.delete('/api/admin/users/:id/senior-moderator', requireAdmin, async (req, res) => {
    try {
        const userId = Number(req.params.id);
        await db.run("UPDATE users SET role = 'user' WHERE id = ? AND role = 'senior_moderator'", [userId]);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to remove senior moderator' });
    }
});

// ============================================================
// ВЕРИФИКАЦИЯ (синяя галочка около ника) — как в TikTok.
// Выдавать/снимать может админ или ст. модератор.
// Важно: администраторам (role = 'admin') галочку может выдать/снять
// только другой полноправный админ — ст. модератору трогать
// защищённые аккаунты нельзя.
// ============================================================
app.post('/api/admin/users/:id/verify', requireVerifier, async (req, res) => {
    try {
        const userId = Number(req.params.id);
        const user = await db.get('SELECT id, role FROM users WHERE id = ?', [userId]);
        if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

        const granterRole = String(req.user.role || '').trim().toLowerCase();
        if (user.role === 'admin' && granterRole !== 'admin') {
            return res.status(403).json({ error: 'Выдать верификацию администратору может только другой администратор' });
        }

        await db.run(
            'UPDATE users SET is_verified = 1, verified_by = ?, verified_at = ? WHERE id = ?',
            [req.user.id, new Date().toISOString(), userId]
        );

        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to verify user' });
    }
});

app.delete('/api/admin/users/:id/verify', requireVerifier, async (req, res) => {
    try {
        const userId = Number(req.params.id);
        const user = await db.get('SELECT id, role FROM users WHERE id = ?', [userId]);
        if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

        const granterRole = String(req.user.role || '').trim().toLowerCase();
        if (user.role === 'admin' && granterRole !== 'admin') {
            return res.status(403).json({ error: 'Снять верификацию у администратора может только другой администратор' });
        }

        await db.run(
            'UPDATE users SET is_verified = 0, verified_by = NULL, verified_at = NULL WHERE id = ?',
            [userId]
        );
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to unverify user' });
    }
});

// ============================================================
// ✅ ИСПРАВЛЕНИЕ: раньше requireModerator (включая САМУЮ младшую
// роль junior_moderator) пускал на бан/разбан ЛЮБОГО пользователя,
// кроме admin. Это значило, что junior_moderator мог забанить
// senior_moderator или обычного moderator — нарушение иерархии
// ролей. Теперь: забанить/разбанить участника из числа STAFF_ROLES
// (moderator/junior_moderator/senior_moderator) может только admin;
// обычных пользователей по-прежнему может банить любой сотрудник
// из STAFF_ROLES.
// ============================================================
app.post('/api/admin/users/:id/ban', requireModerator, async (req, res) => {
    try {
        const userId = Number(req.params.id);
        const { reason, banned_until } = req.body;

        const user = await db.get('SELECT id, username, role FROM users WHERE id = ?', [userId]);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.role === 'admin') return res.status(403).json({ error: 'Cannot ban administrator' });

        const targetRole = String(user.role || '').trim().toLowerCase();
        const granterRole = String(req.user.role || '').trim().toLowerCase();
        if (STAFF_ROLES.includes(targetRole) && granterRole !== 'admin') {
            return res.status(403).json({ error: 'Банить сотрудников (модераторов) может только администратор' });
        }

        await db.run(
            'UPDATE users SET is_banned = 1, ban_reason = ?, banned_until = ? WHERE id = ?',
            [sanitizeInput(String(reason || 'Нарушение правил').slice(0, 300)), banned_until || null, userId]
        );

        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to ban user' });
    }
});

app.post('/api/admin/users/:id/unban', requireModerator, async (req, res) => {
    try {
        const userId = Number(req.params.id);

        // Та же логика иерархии, что и при бане: разбанить сотрудника
        // может только admin.
        const user = await db.get('SELECT id, role FROM users WHERE id = ?', [userId]);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const targetRole = String(user.role || '').trim().toLowerCase();
        const granterRole = String(req.user.role || '').trim().toLowerCase();
        if (STAFF_ROLES.includes(targetRole) && granterRole !== 'admin') {
            return res.status(403).json({ error: 'Разбанить сотрудника (модератора) может только администратор' });
        }

        await db.run(
            'UPDATE users SET is_banned = 0, ban_reason = NULL, banned_until = NULL WHERE id = ?',
            [userId]
        );
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to unban user' });
    }
});

app.get('/api/admin/collections', requireModerator, async (req, res) => {
    try {
        const collections = await db.all(`
            SELECT c.id, c.name, c.description, c.is_public, c.user_id,
                   u.username, COUNT(ci.id) AS item_count
            FROM collections c
            LEFT JOIN users u ON u.id = c.user_id
            LEFT JOIN collection_items ci ON ci.collection_id = c.id
            GROUP BY c.id
            ORDER BY c.id DESC
        `);
        res.json(collections);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to load collections' });
    }
});

app.delete('/api/admin/collections/:id', requireModerator, async (req, res) => {
    try {
        const collectionId = Number(req.params.id);
        const collection = await db.get('SELECT id FROM collections WHERE id = ?', [collectionId]);
        if (!collection) return res.status(404).json({ error: 'Collection not found' });

        await db.run('DELETE FROM collection_items WHERE collection_id = ?', [collectionId]);
        await db.run('DELETE FROM collections WHERE id = ?', [collectionId]);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to delete collection' });
    }
});

app.get('/api/admin/stats', requireModerator, async (req, res) => {
    try {
        const users = await db.get('SELECT COUNT(*) AS count FROM users');
        const moderators = await db.get(
            "SELECT COUNT(*) AS count FROM users WHERE role IN ('moderator','junior_moderator','senior_moderator')"
        );
        const juniorModerators = await db.get("SELECT COUNT(*) AS count FROM users WHERE role = 'junior_moderator'");
        const seniorModerators = await db.get("SELECT COUNT(*) AS count FROM users WHERE role = 'senior_moderator'");
        const banned = await db.get('SELECT COUNT(*) AS count FROM users WHERE is_banned = 1');
        const collections = await db.get('SELECT COUNT(*) AS count FROM collections');
        const verified = await db.get('SELECT COUNT(*) AS count FROM users WHERE is_verified = 1');

        res.json({
            users: users.count,
            moderators: moderators.count,
            junior_moderators: juniorModerators.count,
            senior_moderators: seniorModerators.count,
            banned: banned.count,
            collections: collections.count,
            verified: verified.count
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to load statistics' });
    }
});

// ============================================================
// СИСТЕМА ТЕГОВ ПОЛЬЗОВАТЕЛЕЙ
//
// Логика: есть каталог тегов (tags) — как бы "шаблоны" вроде
// "Проверенный", "Топ загрузчик", "VIP" со своим цветом/иконкой.
// Админ создаёт тег один раз, а дальше выдаёт/снимает его любому
// количеству пользователей. Один и тот же тег можно выдать многим.
// ============================================================

// Публичный список всех существующих тегов (нужно фронту чтобы
// знать имя/цвет/иконку по id — доступно всем, ничего секретного тут нет)
app.get('/api/tags', async (req, res) => {
    try {
        const tags = await db.all('SELECT * FROM tags ORDER BY name');
        res.json(tags);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to load tags' });
    }
});

// Создать новый тег в каталоге — только админ
app.post('/api/admin/tags', requireAdmin, async (req, res) => {
    try {
        const { name, color, icon } = req.body;
        if (!name || !String(name).trim()) {
            return res.status(400).json({ error: 'Укажите название тега' });
        }

        const cleanName = sanitizeInput(String(name).trim().slice(0, 30));
        const cleanColor = /^#[0-9a-fA-F]{3,6}$/.test(color || '') ? color : '#7ec384';
        const cleanIcon = sanitizeInput(String(icon || '').slice(0, 10)); // например эмодзи

        const result = await db.run(
            'INSERT INTO tags (name, color, icon, created_at) VALUES (?, ?, ?, ?)',
            [cleanName, cleanColor, cleanIcon, new Date().toISOString()]
        );

        res.json({ success: true, id: result.lastID });
    } catch (error) {
        res.status(400).json({ error: 'Тег с таким названием уже существует' });
    }
});

// Удалить тег из каталога целиком (снимается у всех, кому был выдан) — только админ
app.delete('/api/admin/tags/:id', requireAdmin, async (req, res) => {
    try {
        const tagId = Number(req.params.id);
        await db.run('DELETE FROM user_tags WHERE tag_id = ?', [tagId]);
        await db.run('DELETE FROM tags WHERE id = ?', [tagId]);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to delete tag' });
    }
});

// Посмотреть какие теги уже есть у конкретного пользователя (для UI в админке) — модератор+
app.get('/api/admin/users/:id/tags', requireModerator, async (req, res) => {
    try {
        const tags = await db.all(`
            SELECT t.id, t.name, t.color, t.icon
            FROM user_tags ut
            JOIN tags t ON t.id = ut.tag_id
            WHERE ut.user_id = ?
        `, [req.params.id]);
        res.json(tags);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to load user tags' });
    }
});

// Выдать тег пользователю — админ, ст. модератор или мл. модератор
app.post('/api/admin/users/:id/tags', requireTagGranter, async (req, res) => {
    try {
        const userId = Number(req.params.id);
        const { tag_id } = req.body;
        if (!tag_id) return res.status(400).json({ error: 'Укажите tag_id' });

        const user = await db.get('SELECT id FROM users WHERE id = ?', [userId]);
        if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

        const tag = await db.get('SELECT id FROM tags WHERE id = ?', [tag_id]);
        if (!tag) return res.status(404).json({ error: 'Тег не найден' });

        await db.run(
            'INSERT INTO user_tags (user_id, tag_id, assigned_at, assigned_by) VALUES (?, ?, ?, ?)',
            [userId, tag_id, new Date().toISOString(), req.session.user.id]
        );

        res.json({ success: true });
    } catch (error) {
        res.status(409).json({ error: 'У пользователя уже есть этот тег' });
    }
});

// Снять тег с пользователя — админ, ст. модератор или мл. модератор
app.delete('/api/admin/users/:id/tags/:tagId', requireTagGranter, async (req, res) => {
    try {
        await db.run(
            'DELETE FROM user_tags WHERE user_id = ? AND tag_id = ?',
            [req.params.id, req.params.tagId]
        );
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to remove tag' });
    }
});

let db;

async function addColumnIfNotExists(table, column, definition) {
    const columns = await db.all(`PRAGMA table_info(${table})`);
    if (!columns.some(c => c.name === column)) {
        await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        console.log(`✅ Добавлена колонка ${table}.${column}`);
    }
}

async function startServer() {
    try {
        db = await open({ filename: './database.db', driver: sqlite3.Database });

        await db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                role TEXT DEFAULT 'user'
            );
            CREATE TABLE IF NOT EXISTS news (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                image TEXT,
                date TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS video_likes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                video_name TEXT NOT NULL,
                UNIQUE(user_id, video_name)
            );
            CREATE TABLE IF NOT EXISTS video_downloads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                video_name TEXT NOT NULL,
                count INTEGER DEFAULT 0,
                UNIQUE(video_name)
            );
            CREATE TABLE IF NOT EXISTS collections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                description TEXT,
                is_public INTEGER DEFAULT 1,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS submissions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                filename TEXT NOT NULL,
                display_name TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS collection_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collection_id INTEGER NOT NULL,
                video_name TEXT NOT NULL,
                added_at TEXT NOT NULL,
                UNIQUE(collection_id, video_name)
            );
            CREATE TABLE IF NOT EXISTS user_points (
                user_id INTEGER PRIMARY KEY,
                points INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS cards (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT,
                image TEXT,
                rarity TEXT NOT NULL,
                drop_weight INTEGER DEFAULT 100,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS user_cards (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                card_id INTEGER NOT NULL,
                amount INTEGER DEFAULT 1,
                obtained_at TEXT NOT NULL,
                UNIQUE(user_id, card_id)
            );
            CREATE TABLE IF NOT EXISTS card_drops (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                card_id INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS telegram_users (
                telegram_id TEXT PRIMARY KEY,
                telegram_username TEXT,
                user_id INTEGER,
                first_seen TEXT NOT NULL,
                last_seen TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS airdrops (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                coins INTEGER NOT NULL,
                max_claims INTEGER,
                claims INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS airdrop_claims (
                airdrop_id INTEGER,
                user_id INTEGER,
                PRIMARY KEY (airdrop_id, user_id)
            );

            -- НОВОЕ: каталог тегов + связка "какому пользователю какой тег выдан"
            CREATE TABLE IF NOT EXISTS tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                color TEXT DEFAULT '#7ec384',
                icon TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS user_tags (
                user_id INTEGER NOT NULL,
                tag_id INTEGER NOT NULL,
                assigned_at TEXT NOT NULL,
                assigned_by INTEGER,
                PRIMARY KEY (user_id, tag_id)
            );

            -- НОВОЕ: очередь уведомлений для Telegram-бота (см. queueNotification выше)
            CREATE TABLE IF NOT EXISTS bot_notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL,
                target_user_id INTEGER,
                title TEXT,
                message TEXT,
                image_path TEXT,
                link TEXT,
                created_at TEXT NOT NULL,
                processed INTEGER DEFAULT 0
            );
        `);

        await addColumnIfNotExists('users', 'is_banned', 'INTEGER DEFAULT 0');
        await addColumnIfNotExists('users', 'ban_reason', 'TEXT');
        await addColumnIfNotExists('users', 'banned_until', 'TEXT');
        await addColumnIfNotExists('users', 'telegram_id', 'TEXT');
        await addColumnIfNotExists('users', 'telegram_username', 'TEXT');
        await addColumnIfNotExists('users', 'telegram_link_code', 'TEXT');
        await addColumnIfNotExists('users', 'telegram_link_expires', 'TEXT');
        // НОВОЕ: адресная доставка кодов регистрации/входа в конкретный Telegram-чат
        // (не всегда есть связанный user_id на момент отправки — например,
        // при регистрации аккаунта ещё не существует)
        await addColumnIfNotExists('bot_notifications', 'target_chat_id', 'TEXT');

        // Верификация (синяя галочка около ника, как в TikTok)
        await addColumnIfNotExists('users', 'is_verified', 'INTEGER DEFAULT 0');
        await addColumnIfNotExists('users', 'verified_by', 'INTEGER');
        await addColumnIfNotExists('users', 'verified_at', 'TEXT');

        // Итоговое имя файла после одобрения футажа — нужно, чтобы
        // связывать видео из /videos с автором заявки (для ника/тега/галочки под футажом)
        await addColumnIfNotExists('submissions', 'final_filename', 'TEXT');

        // ============================================================
        // ✅ ИСПРАВЛЕНИЕ: раньше здесь на КАЖДОМ старте сервера роль
        // admin выдавалась по имени пользователя ('Admin'/'Moder').
        // Проблема: RESERVED_USERNAMES теперь просто блокирует
        // регистрацию под этими именами (см. выше), а сама выдача роли
        // admin выполняется один раз вручную — например, командой:
        //   node -e "require('./grant-admin.js')('ИМЯ_АККАУНТА')"
        // или прямым UPDATE в БД. Автоматической выдачи роли admin по
        // логину при каждом запуске больше нет.
        // ============================================================

        console.log('✅ БД подключена!');

        app.listen(PORT, () => {
            console.log(`✅ Сервер запущен на порту ${PORT}`);
        });

    } catch (err) {
        console.error('❌ Ошибка БД:', err);
        process.exit(1);
    }
}

app.post('/api/telegram/link-code', async (req, res) => {
    try {
        if (!req.session.user) {
            return res.status(401).json({ error: 'Нужно войти в аккаунт' });
        }

        const userId = req.session.user.id;
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();

        await db.run(`
            UPDATE users
            SET telegram_link_code = ?, telegram_link_expires = ?
            WHERE id = ?
        `, [code, expires, userId]);

        console.log(`Telegram link code for user ${userId}: ${code}`);

        res.json({ success: true, code: code });
    } catch (error) {
        console.error('Telegram link error:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ПРИМЕЧАНИЕ: этот эндпоинт обращается к таблице telegram_accounts,
// которой нет в схеме (есть telegram_users с другими колонками) — это
// баг из исходного кода, не трогал его в рамках этой правки, чтобы не
// расширять объём изменений. Стоит проверить/поправить отдельно.
app.get('/api/telegram/status', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Нужно войти' });
    }

    const account = await db.get(`
        SELECT telegram_username, telegram_id, language, created_at
        FROM telegram_accounts
        WHERE user_id = ?
    `, [req.session.user.id]);

    res.json({
        linked: !!account,
        account: account || null
    });
});

app.post('/api/telegram/unlink', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'Нужно войти' });
    }

    await db.run(`DELETE FROM telegram_accounts WHERE user_id = ?`, [req.session.user.id]);
    res.json({ success: true });
});

startServer();
