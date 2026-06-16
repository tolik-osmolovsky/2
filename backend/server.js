const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { body, validationResult } = require('express-validator');
const http = require('http');
const socketIo = require('socket.io');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: [
      "http://localhost:5500",
      "https://collaborative-daily.onrender.com"
    ],
    methods: ["GET", "POST"]
  }
});

app.use(cors({
  origin: [
    'http://localhost:5500',
    'https://collaborative-daily.onrender.com'
  ],
  credentials: true
}));
app.use(express.json());

// Подключение к PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false }
});

// ============ ЗАЩИТА ОТ БРУТФОРСА ============

// 1. Строгий лимит для логина (защита от подбора паролей)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 5,                   // максимум 5 попыток
  message: {
    error: 'Слишком много попыток входа. Пожалуйста, попробуйте через 15 минут.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Ограничиваем по email, чтобы злоумышленник не мог подбирать пароль к конкретному аккаунту с разных IP
  keyGenerator: (req) => req.body.email || req.ip
});

// 2. Лимит для регистрации (защита от спама аккаунтами)
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 час
  max: 10,                  // максимум 10 регистраций с одного IP
  message: {
    error: 'Слишком много попыток регистрации. Пожалуйста, попробуйте через час.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Для регистрации ограничиваем по IP
  keyGenerator: (req) => req.ip
});

// 3. Глобальный лимит для всех API (защита от DoS-атак)
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 минута
  max: 100,            // 100 запросов в минуту с одного IP
  message: {
    error: 'Слишком много запросов. Пожалуйста, попробуйте позже.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Пропускаем успешные запросы (чтобы не наказывать легитимных пользователей)
  skipSuccessfulRequests: true
});

// Применяем глобальный лимит ко всем API
app.use('/api/', globalLimiter);

// ============ Middleware для проверки JWT ============
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Недействительный токен' });
    req.user = user;
    next();
  });
};

// ============ РЕГИСТРАЦИЯ (с защитой) ============
app.post('/api/register', registerLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('full_name').notEmpty().trim()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { email, password, full_name } = req.body;

  try {
    const userExists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: 'Пользователь с таким email уже существует' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      'INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id, email, full_name',
      [email, hashedPassword, full_name]
    );

    const user = result.rows[0];
    const token = jwt.sign(
      { id: user.id, email: user.email, full_name: user.full_name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ token, user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============ ЛОГИН (с защитой) ============
app.post('/api/login', loginLimiter, [
  body('email').isEmail(),
  body('password').notEmpty()
], async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query(
      'SELECT id, email, password_hash, full_name FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, full_name: user.full_name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============ РАБОТА С ПРОСТРАНСТВАМИ ============
app.post('/api/spaces', authenticateToken, [
  body('name').notEmpty().trim()
], async (req, res) => {
  const { name, description } = req.body;
  const userId = req.user.id;

  try {
    const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();

    const spaceResult = await pool.query(
      'INSERT INTO spaces (name, description, created_by, invite_code) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, description, userId, inviteCode]
    );

    const space = spaceResult.rows[0];

    await pool.query(
      'INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)',
      [space.id, userId, 'owner']
    );

    res.json(space);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка создания пространства' });
  }
});

app.get('/api/my-spaces', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await pool.query(
      `SELECT s.*, 
        (SELECT COUNT(*) FROM space_members WHERE space_id = s.id) as members_count
       FROM spaces s
       JOIN space_members sm ON s.id = sm.space_id
       WHERE sm.user_id = $1
       ORDER BY s.created_at DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка загрузки пространств' });
  }
});

app.post('/api/spaces/join/:inviteCode', authenticateToken, async (req, res) => {
  const { inviteCode } = req.params;
  const userId = req.user.id;

  try {
    const spaceResult = await pool.query(
      'SELECT id FROM spaces WHERE invite_code = $1',
      [inviteCode]
    );

    if (spaceResult.rows.length === 0) {
      return res.status(404).json({ error: 'Неверный код приглашения' });
    }

    const spaceId = spaceResult.rows[0].id;

    const checkMember = await pool.query(
      'SELECT * FROM space_members WHERE space_id = $1 AND user_id = $2',
      [spaceId, userId]
    );

    if (checkMember.rows.length > 0) {
      return res.status(400).json({ error: 'Вы уже участник этого пространства' });
    }

    await pool.query(
      'INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)',
      [spaceId, userId, 'member']
    );

    res.json({ message: 'Успешно присоединились', spaceId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка присоединения' });
  }
});

// ============ РАБОТА С ЗАДАЧАМИ ============
app.get('/api/spaces/:spaceId/tasks', authenticateToken, async (req, res) => {
  const { spaceId } = req.params;
  const userId = req.user.id;

  try {
    const isMember = await pool.query(
      'SELECT * FROM space_members WHERE space_id = $1 AND user_id = $2',
      [spaceId, userId]
    );

    if (isMember.rows.length === 0) {
      return res.status(403).json({ error: 'Доступ запрещен' });
    }

    const tasksResult = await pool.query(
      `SELECT t.*,
        creator.full_name as created_by_name,
        assignee.full_name as assigned_to_name
       FROM tasks t
       LEFT JOIN users creator ON t.created_by = creator.id
       LEFT JOIN users assignee ON t.assigned_to = assignee.id
       WHERE t.space_id = $1
       ORDER BY t.due_date ASC, t.due_time ASC`,
      [spaceId]
    );

    const tasks = await Promise.all(tasksResult.rows.map(async (task) => {
      const commentsResult = await pool.query(
        `SELECT tc.*, u.full_name 
         FROM task_comments tc
         JOIN users u ON tc.user_id = u.id
         WHERE tc.task_id = $1
         ORDER BY tc.created_at ASC`,
        [task.id]
      );
      return { ...task, comments: commentsResult.rows };
    }));

    res.json(tasks);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка загрузки задач' });
  }
});

app.post('/api/tasks', authenticateToken, [
  body('space_id').isInt(),
  body('title').notEmpty(),
  body('due_date').isDate()
], async (req, res) => {
  const { space_id, title, description, due_date, due_time, assigned_to } = req.body;
  const userId = req.user.id;

  try {
    const isMember = await pool.query(
      'SELECT * FROM space_members WHERE space_id = $1 AND user_id = $2',
      [space_id, userId]
    );

    if (isMember.rows.length === 0) {
      return res.status(403).json({ error: 'Доступ запрещен' });
    }

    const result = await pool.query(
      `INSERT INTO tasks (space_id, title, description, due_date, due_time, created_by, assigned_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [space_id, title, description, due_date, due_time, userId, assigned_to || null]
    );

    const task = result.rows[0];

    await pool.query(
      `INSERT INTO task_history (task_id, user_id, action)
       VALUES ($1, $2, $3)`,
      [task.id, userId, 'created']
    );

    io.to(`space_${space_id}`).emit('task_created', task);

    res.json(task);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка создания задачи' });
  }
});

// Получить одну задачу по ID
app.get('/api/tasks/:taskId', authenticateToken, async (req, res) => {
  const { taskId } = req.params;
  const userId = req.user.id;

  try {
    const result = await pool.query(
      `SELECT t.*,
        creator.full_name as created_by_name,
        assignee.full_name as assigned_to_name
       FROM tasks t
       LEFT JOIN users creator ON t.created_by = creator.id
       LEFT JOIN users assignee ON t.assigned_to = assignee.id
       JOIN space_members sm ON t.space_id = sm.space_id
       WHERE t.id = $1 AND sm.user_id = $2`,
      [taskId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Задача не найдена' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка загрузки задачи' });
  }
});

// ============ ОБНОВЛЕНИЕ ЗАДАЧИ (PUT) ============
app.put('/api/tasks/:taskId', authenticateToken, [
  body('title').notEmpty(),
  body('due_date').isDate()
], async (req, res) => {
  const { taskId } = req.params;
  const { title, description, due_date, due_time, assigned_to } = req.body;
  const userId = req.user.id;

  try {
    const taskResult = await pool.query(
      `SELECT t.*, sm.user_id 
       FROM tasks t
       JOIN space_members sm ON t.space_id = sm.space_id
       WHERE t.id = $1 AND sm.user_id = $2`,
      [taskId, userId]
    );

    if (taskResult.rows.length === 0) {
      return res.status(403).json({ error: 'Доступ запрещен' });
    }

    const task = taskResult.rows[0];
    const spaceId = task.space_id;

    const result = await pool.query(
      `UPDATE tasks 
       SET title = $1, description = $2, due_date = $3, due_time = $4, 
           assigned_to = $5, updated_at = CURRENT_TIMESTAMP
       WHERE id = $6 RETURNING *`,
      [title, description, due_date, due_time, assigned_to || null, taskId]
    );

    await pool.query(
      `INSERT INTO task_history (task_id, user_id, action, new_value)
       VALUES ($1, $2, $3, $4)`,
      [taskId, userId, 'updated', 'Задача обновлена']
    );

    io.to(`space_${spaceId}`).emit('task_updated', result.rows[0]);

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка обновления задачи' });
  }
});

// ============ ОСТАЛЬНЫЕ МАРШРУТЫ ============
app.patch('/api/tasks/:taskId/status', authenticateToken, async (req, res) => {
  const { taskId } = req.params;
  const { is_completed } = req.body;
  const userId = req.user.id;

  try {
    const taskResult = await pool.query(
      `SELECT t.*, sm.user_id 
       FROM tasks t
       JOIN space_members sm ON t.space_id = sm.space_id
       WHERE t.id = $1 AND sm.user_id = $2`,
      [taskId, userId]
    );

    if (taskResult.rows.length === 0) {
      return res.status(403).json({ error: 'Доступ запрещен' });
    }

    const completed_at = is_completed ? new Date() : null;

    const result = await pool.query(
      `UPDATE tasks 
       SET is_completed = $1, completed_at = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 RETURNING *`,
      [is_completed, completed_at, taskId]
    );

    await pool.query(
      `INSERT INTO task_history (task_id, user_id, action, new_value)
       VALUES ($1, $2, $3, $4)`,
      [taskId, userId, is_completed ? 'completed' : 'uncompleted', is_completed.toString()]
    );

    const updatedTask = result.rows[0];
    const spaceId = updatedTask.space_id;

    io.to(`space_${spaceId}`).emit('task_status_changed', updatedTask);

    res.json(updatedTask);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка обновления статуса' });
  }
});

app.post('/api/tasks/:taskId/comments', authenticateToken, [
  body('comment').notEmpty().trim()
], async (req, res) => {
  const { taskId } = req.params;
  const { comment } = req.body;
  const userId = req.user.id;

  try {
    const accessCheck = await pool.query(
      `SELECT t.id, t.space_id
       FROM tasks t
       JOIN space_members sm ON t.space_id = sm.space_id
       WHERE t.id = $1 AND sm.user_id = $2`,
      [taskId, userId]
    );

    if (accessCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Доступ запрещен' });
    }

    const spaceId = accessCheck.rows[0].space_id;

    const result = await pool.query(
      `INSERT INTO task_comments (task_id, user_id, comment)
       VALUES ($1, $2, $3) RETURNING *`,
      [taskId, userId, comment]
    );

    const userInfo = await pool.query(
      'SELECT full_name FROM users WHERE id = $1',
      [userId]
    );

    const newComment = {
      ...result.rows[0],
      full_name: userInfo.rows[0].full_name
    };

    await pool.query(
      `INSERT INTO task_history (task_id, user_id, action, new_value)
       VALUES ($1, $2, $3, $4)`,
      [taskId, userId, 'commented', comment.substring(0, 100)]
    );

    io.to(`space_${spaceId}`).emit('comment_added', { taskId, comment: newComment });

    res.json(newComment);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка добавления комментария' });
  }
});

app.get('/api/spaces/:spaceId/members', authenticateToken, async (req, res) => {
  const { spaceId } = req.params;

  try {
    const members = await pool.query(
      `SELECT u.id, u.full_name, u.email, sm.role, sm.joined_at
       FROM space_members sm
       JOIN users u ON sm.user_id = u.id
       WHERE sm.space_id = $1`,
      [spaceId]
    );

    res.json(members.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка загрузки участников' });
  }
});

// ============ УДАЛЕНИЕ ============
app.delete('/api/spaces/:spaceId', authenticateToken, async (req, res) => {
  const { spaceId } = req.params;
  const userId = req.user.id;

  try {
    const spaceCheck = await pool.query(
      'SELECT * FROM spaces WHERE id = $1 AND created_by = $2',
      [spaceId, userId]
    );

    if (spaceCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Только владелец может удалить пространство' });
    }

    await pool.query('DELETE FROM spaces WHERE id = $1', [spaceId]);

    io.to(`space_${spaceId}`).emit('space_deleted', { spaceId });

    res.json({ message: 'Пространство удалено' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

app.delete('/api/tasks/:taskId', authenticateToken, async (req, res) => {
  const { taskId } = req.params;
  const userId = req.user.id;

  try {
    const taskResult = await pool.query(
      `SELECT t.*, sm.user_id 
       FROM tasks t
       JOIN space_members sm ON t.space_id = sm.space_id
       WHERE t.id = $1 AND sm.user_id = $2`,
      [taskId, userId]
    );

    if (taskResult.rows.length === 0) {
      return res.status(403).json({ error: 'Доступ запрещен' });
    }

    const task = taskResult.rows[0];
    const spaceId = task.space_id;

    await pool.query('DELETE FROM tasks WHERE id = $1', [taskId]);

    io.to(`space_${spaceId}`).emit('task_deleted', { taskId, spaceId });

    res.json({ message: 'Задача удалена' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

// ============ WEBSOCKETS ============
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    return next(new Error('Authentication error'));
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return next(new Error('Authentication error'));
    socket.user = user;
    next();
  });
});

io.on('connection', (socket) => {
  console.log(`User ${socket.user.email} connected`);

  socket.on('join_space', async (spaceId) => {
    const check = await pool.query(
      'SELECT * FROM space_members WHERE space_id = $1 AND user_id = $2',
      [spaceId, socket.user.id]
    );

    if (check.rows.length > 0) {
      socket.join(`space_${spaceId}`);
      console.log(`${socket.user.email} joined space ${spaceId}`);
    }
  });

  socket.on('disconnect', () => {
    console.log(`User ${socket.user.email} disconnected`);
  });
});

// ============ РАЗДАЧА ФРОНТЕНДА ============
const path = require('path');
app.use(express.static(path.join(__dirname, '../frontend')));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  res.sendFile(path.join(__dirname, '../frontend', 'index.html'));
});

// ============ ЗАПУСК СЕРВЕРА ============
server.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});