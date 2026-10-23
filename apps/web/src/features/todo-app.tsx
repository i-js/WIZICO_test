'use client';

import { useCallback, useEffect, useState } from 'react';
import { userSchema, type User } from '@todo/contracts';
import { apiUrl } from './sync/use-collaboration';
import { Workspace } from './workspace';

export function TodoApp() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const expired = useCallback(() => {
    setUser(null);
    localStorage.removeItem('todo-user');
    setMessage('Войдите снова. Неотправленные действия и черновики сохранены на устройстве.');
  }, []);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const response = await fetch(`${apiUrl}/auth/me`, {
          credentials: 'include',
          cache: 'no-store',
        });
        if (response.ok) {
          const current = userSchema.parse(await response.json());
          if (alive) {
            setUser(current);
            localStorage.setItem('todo-user', JSON.stringify(current));
          }
        } else if (response.status === 401) localStorage.removeItem('todo-user');
        else throw new Error('Server unavailable');
      } catch {
        try {
          const cached = userSchema.safeParse(
            JSON.parse(localStorage.getItem('todo-user') ?? 'null'),
          );
          if (alive && cached.success) setUser(cached.data);
          else if (alive) setMessage('Сервер недоступен. Для первого входа необходимо соединение.');
        } catch {
          if (alive) setMessage('Не удалось восстановить сессию');
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key !== 'todo-user') return;
      if (!event.newValue) {
        setUser(null);
        return;
      }
      try {
        const result = userSchema.safeParse(JSON.parse(event.newValue));
        if (result.success) setUser(result.data);
      } catch {
        /* Invalid browser storage is ignored. */
      }
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  if (loading)
    return (
      <main className="loading" aria-live="polite">
        Загружаем список дел…
      </main>
    );
  if (user)
    return (
      <Workspace
        key={user.id}
        user={user}
        onExpired={expired}
        onLogout={async () => {
          try {
            const response = await fetch(`${apiUrl}/auth/logout`, {
              method: 'POST',
              credentials: 'include',
            });
            if (!response.ok) throw new Error('Logout failed');
            localStorage.removeItem('todo-user');
            setUser(null);
            setMessage('Вы вышли из аккаунта.');
          } catch {
            throw new Error('Для выхода нужно соединение с сервером');
          }
        }}
      />
    );
  return (
    <Login
      message={message}
      onLogin={(current) => {
        setUser(current);
        localStorage.setItem('todo-user', JSON.stringify(current));
      }}
    />
  );
}

function Login({ message, onLogin }: { message: string; onLogin: (user: User) => void }) {
  const [email, setEmail] = useState('alice@example.com');
  const [password, setPassword] = useState('demo-password');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <main className="login-page">
      <section className="login-story">
        <div className="brand">
          <span className="brand-mark">✓</span> Список дел
        </div>
        <div>
          <span className="eyebrow">ПЛАНЫ СТАНОВЯТСЯ ДЕЛАМИ</span>
          <h1>
            Один список.
            <br />
            Два человека.
            <br />
            <em>Общий результат.</em>
          </h1>
          <p>
            Планируйте вместе, отмечайте сделанное и продолжайте работать, даже когда пропадает
            соединение.
          </p>
        </div>
        <div className="story-foot">
          <span className="status-dot" /> Изменения появляются у обоих участников
        </div>
      </section>
      <section className="login-form-wrap">
        <form
          className="login-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError('');
            try {
              const response = await fetch(`${apiUrl}/auth/login`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password }),
              });
              if (!response.ok) {
                setError(
                  response.status === 429
                    ? 'Слишком много попыток входа. Попробуйте позже'
                    : response.status === 401
                      ? 'Неверный email или пароль'
                      : 'Не удалось войти. Повторите попытку',
                );
                return;
              }
              onLogin(userSchema.parse(await response.json()));
            } catch {
              setError('Нет связи с сервером. Проверьте соединение');
            } finally {
              setBusy(false);
            }
          }}
        >
          <span className="eyebrow">РАДЫ ВАС ВИДЕТЬ</span>
          <h2>Войти в пространство</h2>
          <p className="muted">Ваши задачи уже ждут вас.</p>
          {message && (
            <p className="info" role="status">
              {message}
            </p>
          )}
          <label>
            Email
            <input
              name="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            Пароль
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy} type="submit">
            {busy ? 'Входим…' : 'Войти →'}
          </button>
          <div className="demo">
            <strong>Два аккаунта для знакомства</strong>
            <p>
              Пароль обоих: <code>demo-password</code>
            </p>
            <div className="button-row">
              <button
                type="button"
                className="secondary"
                onClick={() => setEmail('alice@example.com')}
              >
                Алиса
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => setEmail('bob@example.com')}
              >
                Борис
              </button>
            </div>
            <p>Откройте второй аккаунт в другом браузере или окне инкогнито.</p>
          </div>
        </form>
      </section>
    </main>
  );
}
