const API_URL = 'http://localhost:3000/api';
let currentToken = localStorage.getItem('token');
let currentUser = null;
let currentSpace = null;
let socket = null;

// Инициализация
if (currentToken) {
    checkAuth();
} else {
    document.getElementById('authContainer').classList.remove('hidden');
}

async function checkAuth() {
    try {
        // Просто проверяем, что токен есть и можно загрузить пространства
        const response = await fetch(`${API_URL}/my-spaces`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        if (response.ok) {
            const userData = JSON.parse(atob(currentToken.split('.')[1]));
            currentUser = userData;
            document.getElementById('userName').innerText = userData.full_name;
            document.getElementById('authContainer').classList.add('hidden');
            document.getElementById('dashboard').classList.remove('hidden');
            loadSpaces();
            initSocket();
        } else {
            logout();
        }
    } catch (error) {
        logout();
    }
}

function initSocket() {
    socket = io('http://localhost:3000', {
        auth: { token: currentToken }
    });
    
    socket.on('connect', () => {
        console.log('Socket connected');
        if (currentSpace) {
            socket.emit('join_space', currentSpace.id);
        }
    });
    
    socket.on('task_created', (task) => {
        if (currentSpace && task.space_id === currentSpace.id) {
            loadTasks();
        }
    });
    
    socket.on('task_status_changed', (task) => {
        if (currentSpace && task.space_id === currentSpace.id) {
            loadTasks();
        }
    });
    
    socket.on('comment_added', (data) => {
        if (currentSpace) {
            loadTasks();
        }
    });
}

async function login() {
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    
    try {
        const response = await fetch(`${API_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            localStorage.setItem('token', data.token);
            currentToken = data.token;
            currentUser = data.user;
            document.getElementById('userName').innerText = data.user.full_name;
            document.getElementById('authContainer').classList.add('hidden');
            document.getElementById('dashboard').classList.remove('hidden');
            loadSpaces();
            initSocket();
        } else {
            document.getElementById('authError').innerText = data.error;
        }
    } catch (error) {
        document.getElementById('authError').innerText = 'Ошибка соединения';
    }
}

async function register() {
    const full_name = document.getElementById('regName').value;
    const email = document.getElementById('regEmail').value;
    const password = document.getElementById('regPassword').value;
    
    try {
        const response = await fetch(`${API_URL}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ full_name, email, password })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            localStorage.setItem('token', data.token);
            currentToken = data.token;
            currentUser = data.user;
            document.getElementById('userName').innerText = data.user.full_name;
            document.getElementById('authContainer').classList.add('hidden');
            document.getElementById('dashboard').classList.remove('hidden');
            loadSpaces();
            initSocket();
        } else {
            document.getElementById('regError').innerText = data.error || 'Ошибка регистрации';
        }
    } catch (error) {
        document.getElementById('regError').innerText = 'Ошибка соединения';
    }
}

async function loadSpaces() {
    try {
        const response = await fetch(`${API_URL}/my-spaces`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        const spaces = await response.json();
        const spacesListDiv = document.getElementById('spacesList');
        
        if (spaces.length === 0) {
            spacesListDiv.innerHTML = '<p>У вас пока нет ежедневников. Создайте новый или присоединитесь по коду!</p>';
            return;
        }
        
        spacesListDiv.innerHTML = spaces.map(space => `
            <div class="space-card" onclick="openSpace(${space.id}, '${space.name}', '${space.invite_code}')">
                <h3>📓 ${space.name}</h3>
                <p>${space.description || 'Без описания'}</p>
                <small>👥 Участников: ${space.members_count}</small>
                <br>
                <small>🔑 Код: ${space.invite_code}</small>
            </div>
        `).join('');
    } catch (error) {
        console.error('Error loading spaces:', error);
    }
}

async function createSpace() {
    const name = document.getElementById('spaceName').value;
    const description = document.getElementById('spaceDescription').value;
    
    try {
        const response = await fetch(`${API_URL}/spaces`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ name, description })
        });
        
        if (response.ok) {
            hideCreateSpaceForm();
            loadSpaces();
        } else {
            alert('Ошибка создания');
        }
    } catch (error) {
        alert('Ошибка соединения');
    }
}

async function joinSpace() {
    const inviteCode = document.getElementById('inviteCode').value.toUpperCase();
    
    try {
        const response = await fetch(`${API_URL}/spaces/join/${inviteCode}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${currentToken}`
            }
        });
        
        const data = await response.json();
        
        if (response.ok) {
            hideJoinSpaceForm();
            loadSpaces();
            alert('Вы присоединились к ежедневнику!');
        } else {
            alert(data.error || 'Ошибка присоединения');
        }
    } catch (error) {
        alert('Ошибка соединения');
    }
}

async function openSpace(spaceId, spaceName, inviteCode) {
    currentSpace = { id: spaceId, name: spaceName, invite_code: inviteCode };
    
    document.getElementById('spacesView').classList.add('hidden');
    document.getElementById('tasksView').classList.remove('hidden');
    document.getElementById('currentSpaceName').innerText = spaceName;
    document.getElementById('inviteInfo').innerHTML = `
        🔗 Код для приглашения: <strong>${inviteCode}</strong> 
        <button onclick="copyInviteCode()">📋 Копировать</button>
    `;
    
    if (socket) {
        socket.emit('join_space', spaceId);
    }
    
    await loadMembers();
    await loadTasks();
}

async function loadMembers() {
    try {
        const response = await fetch(`${API_URL}/spaces/${currentSpace.id}/members`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        const members = await response.json();
        const select = document.getElementById('taskAssignedTo');
        select.innerHTML = '<option value="">Не назначать</option>' + 
            members.map(m => `<option value="${m.id}">${m.full_name}</option>`).join('');
    } catch (error) {
        console.error('Error loading members:', error);
    }
}

async function loadTasks() {
    try {
        const response = await fetch(`${API_URL}/spaces/${currentSpace.id}/tasks`, {
            headers: { 'Authorization': `Bearer ${currentToken}` }
        });
        
        const tasks = await response.json();
        const tasksListDiv = document.getElementById('tasksList');
        
        if (tasks.length === 0) {
            tasksListDiv.innerHTML = '<p>✨ Пока нет задач. Добавьте первую задачу!</p>';
            return;
        }
        
        tasksListDiv.innerHTML = tasks.map(task => `
            <div class="task-card ${task.is_completed ? 'completed' : ''}">
                <div class="task-title">
                    <input type="checkbox" ${task.is_completed ? 'checked' : ''} 
                           onchange="toggleTaskStatus(${task.id}, this.checked)">
                    <span style="${task.is_completed ? 'text-decoration: line-through;' : ''}">
                        ${escapeHtml(task.title)}
                    </span>
                </div>
                ${task.description ? `<p>📝 ${escapeHtml(task.description)}</p>` : ''}
                <div class="task-meta">
                    <span class="due-date">📅 ${formatDate(task.due_date)} ${task.due_time ? ' в ' + task.due_time.slice(0,5) : ''}</span>
                    <span>👤 Создал: ${task.created_by_name || 'Unknown'}</span>
                    ${task.assigned_to_name ? `<span>🎯 Назначено: ${task.assigned_to_name}</span>` : ''}
                    ${task.completed_at ? `<span>✅ Выполнено: ${new Date(task.completed_at).toLocaleString()}</span>` : ''}
                </div>
                
                <div class="comments-section">
                    <div class="comments-list">
                        ${(task.comments || []).map(comment => `
                            <div class="comment">
                                <span class="comment-author">${escapeHtml(comment.full_name)}</span>
                                <span>${escapeHtml(comment.comment)}</span>
                                <small>${new Date(comment.created_at).toLocaleString()}</small>
                            </div>
                        `).join('')}
                    </div>
                    <div class="add-comment">
                        <input type="text" id="comment-${task.id}" placeholder="Написать комментарий...">
                        <button onclick="addComment(${task.id})">💬</button>
                    </div>
                </div>
            </div>
        `).join('');
    } catch (error) {
        console.error('Error loading tasks:', error);
    }
}

async function createTask() {
    const title = document.getElementById('taskTitle').value;
    const description = document.getElementById('taskDescription').value;
    const due_date = document.getElementById('taskDueDate').value;
    const due_time = document.getElementById('taskDueTime').value;
    const assigned_to = document.getElementById('taskAssignedTo').value;
    
    if (!title || !due_date) {
        alert('Заполните название и дату выполнения!');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/tasks`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({
                space_id: currentSpace.id,
                title,
                description,
                due_date,
                due_time: due_time || null,
                assigned_to: assigned_to || null
            })
        });
        
        if (response.ok) {
            hideAddTaskForm();
            document.getElementById('taskTitle').value = '';
            document.getElementById('taskDescription').value = '';
            document.getElementById('taskDueDate').value = '';
            document.getElementById('taskDueTime').value = '';
            await loadTasks();
        } else {
            alert('Ошибка создания задачи');
        }
    } catch (error) {
        alert('Ошибка соединения');
    }
}

async function toggleTaskStatus(taskId, isCompleted) {
    try {
        const response = await fetch(`${API_URL}/tasks/${taskId}/status`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ is_completed: isCompleted })
        });
        
        if (response.ok) {
            await loadTasks();
        }
    } catch (error) {
        alert('Ошибка обновления статуса');
    }
}

async function addComment(taskId) {
    const input = document.getElementById(`comment-${taskId}`);
    const comment = input.value.trim();
    
    if (!comment) return;
    
    try {
        const response = await fetch(`${API_URL}/tasks/${taskId}/comments`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${currentToken}`
            },
            body: JSON.stringify({ comment })
        });
        
        if (response.ok) {
            input.value = '';
            await loadTasks();
        } else {
            alert('Ошибка добавления комментария');
        }
    } catch (error) {
        alert('Ошибка соединения');
    }
}

function copyInviteCode() {
    navigator.clipboard.writeText(currentSpace.invite_code);
    alert('Код скопирован! Поделитесь им с другом.');
}

function formatDate(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleDateString('ru-RU');
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

function showCreateSpaceForm() {
    document.getElementById('createSpaceForm').classList.remove('hidden');
}

function hideCreateSpaceForm() {
    document.getElementById('createSpaceForm').classList.add('hidden');
    document.getElementById('spaceName').value = '';
    document.getElementById('spaceDescription').value = '';
}

function showAddTaskForm() {
    document.getElementById('addTaskForm').classList.remove('hidden');
}

function hideAddTaskForm() {
    document.getElementById('addTaskForm').classList.add('hidden');
}

function showJoinSpaceForm() {
    document.getElementById('joinSpaceForm').classList.remove('hidden');
}

function hideJoinSpaceForm() {
    document.getElementById('joinSpaceForm').classList.add('hidden');
    document.getElementById('inviteCode').value = '';
}

function backToSpaces() {
    currentSpace = null;
    document.getElementById('tasksView').classList.add('hidden');
    document.getElementById('spacesView').classList.remove('hidden');
    loadSpaces();
}

function showRegister() {
    document.getElementById('loginForm').classList.add('hidden');
    document.getElementById('registerForm').classList.remove('hidden');
}

function showLogin() {
    document.getElementById('registerForm').classList.add('hidden');
    document.getElementById('loginForm').classList.remove('hidden');
}

function logout() {
    localStorage.removeItem('token');
    currentToken = null;
    currentUser = null;
    if (socket) socket.disconnect();
    location.reload();
}