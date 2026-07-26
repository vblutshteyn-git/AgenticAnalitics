# Развёртывание и запуск

Приложение — один Node-процесс без внешней базы данных. Он одновременно отдаёт
веб-интерфейс, REST API и MCP-эндпоинт, а загруженные наборы хранит в каталоге
на диске. Ставить рядом Postgres, Redis или очередь не нужно.

Требуется **Node.js 20 или новее** (проверено на 22).

---

## 1. Быстрый старт локально

```bash
git clone https://github.com/vblutshteyn-git/AgenticAnalitics.git
cd AgenticAnalitics

npm ci          # установка зависимостей строго по package-lock.json
npm run build   # компиляция TypeScript в dist/
npm start       # запуск
```

Откройте **http://127.0.0.1:4173**, нажмите «SaaS-подписки (демо)», затем
«Найти инсайты».

> `npm ci`, а не `npm install`: он ставит ровно те версии, что зафиксированы в
> `package-lock.json`, и не изменяет его. Для воспроизводимого развёртывания
> это принципиально.

Остановка — `Ctrl+C`. Приложение закрывает слушающий сокет и даёт текущему
анализу завершиться.

### Проверка, что всё поднялось

```bash
curl http://127.0.0.1:4173/healthz
# {"status":"ok","uptimeSeconds":3,"version":"0.1.0"}
```

---

## 2. Вариант A: Docker (рекомендуется)

Самый предсказуемый способ: версия Node, сборка и права зафиксированы в образе.

### Через docker compose

```bash
# необязательно — включает LLM-формулировки и вопросы на естественном языке
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

docker compose up -d --build
docker compose logs -f
```

Готово: **http://127.0.0.1:4173**

Что делает `docker-compose.yml`:

| | |
|---|---|
| Порт | публикуется **только на 127.0.0.1** хоста — наружу сервис сам не выходит |
| Данные | именованный том `agentics-data`, переживает пересоздание контейнера |
| Проба | `/healthz` каждые 30 с; `docker compose ps` покажет `healthy` |
| Перезапуск | `unless-stopped` — поднимется после ребута хоста |
| Память | лимит 2 ГБ (анализ держит набор в памяти) |

Управление:

```bash
docker compose ps            # состояние и healthcheck
docker compose logs -f       # логи
docker compose restart       # перезапуск
docker compose down          # остановить (данные в томе сохранятся)
docker compose down -v       # остановить И УДАЛИТЬ данные
```

### Через голый Docker

```bash
docker build -t agentics-analytics:0.1.0 .

docker run -d --name agentics-analytics \
  -p 127.0.0.1:4173:4173 \
  -v agentics-data:/data \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  --restart unless-stopped \
  agentics-analytics:0.1.0
```

Образ собирается в две стадии: TypeScript и тесты остаются в стадии сборки, в
рантайм едут только продакшн-зависимости и `dist/`. **Сборка падает, если не
проходят тесты** — сломанный артефакт не уедет дальше по недосмотру.

Процесс внутри работает от непривилегированного пользователя `node`, а PID 1 —
`tini`, чтобы сигналы доходили корректно и не копились зомби-процессы.

---

## 3. Вариант B: systemd (без Docker)

Для развёртывания прямо на сервере.

```bash
# 1. Пользователь без оболочки и домашнего каталога
sudo useradd --system --no-create-home --shell /usr/sbin/nologin agentics

# 2. Код
sudo mkdir -p /opt/agentics-analytics
sudo git clone https://github.com/vblutshteyn-git/AgenticAnalitics.git \
  /opt/agentics-analytics
cd /opt/agentics-analytics

# 3. Сборка (нужны dev-зависимости), затем — только продакшн
sudo npm ci
sudo npm run build
sudo npm test                      # необязательно, но лучше не пропускать
sudo npm prune --omit=dev

# 4. Каталог данных
sudo mkdir -p /var/lib/agentics-analytics
sudo chown -R agentics:agentics /var/lib/agentics-analytics /opt/agentics-analytics

# 5. Ключ модели — в отдельный файл с правами 600.
#    В сам юнит его класть нельзя: systemctl cat читает любой пользователь.
sudo mkdir -p /etc/agentics-analytics
echo 'ANTHROPIC_API_KEY=sk-ant-...' | sudo tee /etc/agentics-analytics/env >/dev/null
sudo chmod 600 /etc/agentics-analytics/env

# 6. Служба
sudo cp deploy/agentics-analytics.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agentics-analytics
```

Проверка и управление:

```bash
systemctl status agentics-analytics
journalctl -u agentics-analytics -f
curl http://127.0.0.1:4173/healthz

sudo systemctl restart agentics-analytics
sudo systemctl stop agentics-analytics
```

Юнит уже настроен на изоляцию: `ProtectSystem=strict`, `PrivateTmp`,
`NoNewPrivileges`, запись разрешена **только** в каталог данных.

---

## 4. Публикация наружу

> **У приложения нет собственной аутентификации.** Любой, кто дотянется до
> порта, получит полный доступ к данным и API. Поэтому по умолчанию оно слушает
> `127.0.0.1`, а compose публикует порт только на localhost.

Чтобы открыть доступ, поставьте перед ним обратный прокси с TLS и авторизацией.
Готовый пример — `deploy/nginx.conf.example`:

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/agentics
sudo ln -s /etc/nginx/sites-available/agentics /etc/nginx/sites-enabled/
sudo apt install apache2-utils
sudo htpasswd -c /etc/nginx/.htpasswd ваш-логин
sudo certbot --nginx -d analytics.example.com
sudo nginx -t && sudo systemctl reload nginx
```

**Одна деталь, которую легко пропустить:** прогресс анализа идёт через
Server-Sent Events. Если не отключить буферизацию (`proxy_buffering off`),
nginx накопит ответ и отдаст одним куском в конце — живой ход работы агента
исчезнет, и это будет выглядеть как зависание интерфейса. В примере конфига это
уже сделано для `/api/datasets/` и `/mcp`.

Также поднимите `client_max_body_size` минимум до `64m` — столько принимает само
приложение при загрузке наборов.

---

## 5. Подключение агента по MCP

Веб-интерфейс и MCP делят одно хранилище: набор, загруженный агентом, сразу
виден в браузере, и наоборот.

**stdio** — для Claude Desktop / Claude Code, сервер поднимать не нужно:

```jsonc
{
  "mcpServers": {
    "agentics-analytics": {
      "command": "node",
      "args": ["/opt/agentics-analytics/dist/mcp/stdio.js"],
      "env": { "AGENTICS_DATA_DIR": "/var/lib/agentics-analytics" }
    }
  }
}
```

**streamable HTTP** — когда сервер уже запущен:

```jsonc
{
  "mcpServers": {
    "agentics-analytics": {
      "type": "http",
      "url": "http://127.0.0.1:4173/mcp"
    }
  }
}
```

Проверить эндпоинт вручную:

```bash
curl -s -X POST http://127.0.0.1:4173/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2025-06-18","capabilities":{},
                 "clientInfo":{"name":"probe","version":"1"}}}'
```

В ответе должен прийти `serverInfo` с именем `agentics-analytics`.

---

## 6. Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `PORT` | `4173` | Порт HTTP. |
| `HOST` | `127.0.0.1` | Интерфейс. В Docker — `0.0.0.0`, иначе порт недостижим снаружи контейнера. |
| `AGENTICS_DATA_DIR` | `~/.agentics-analytics` | Каталог с наборами. В Docker — `/data`. |
| `ANTHROPIC_API_KEY` | — | Включает LLM-формулировки и вопросы словами. **Без ключа анализ работает полностью.** |
| `AGENTICS_MODEL` | `claude-opus-5` | Модель для формулировок. |
| `AGENTICS_WEB_ROOT` | определяется автоматически | Каталог фронтенда. Если задан явно и неверен — приложение не стартует, а не подставит запасной путь молча. |
| `NODE_ENV` | — | Ставьте `production` в бою. |

---

## 7. Чек-лист после развёртывания

```bash
BASE=http://127.0.0.1:4173

# 1. процесс жив
curl -fsS $BASE/healthz && echo

# 2. интерфейс отдаётся
curl -fsS -o /dev/null -w 'UI: %{http_code}\n' $BASE/

# 3. API отвечает, видно состояние LLM
curl -fsS $BASE/api/status

# 4. полный цикл: загрузка демо-набора и анализ
curl -fsS -X POST $BASE/api/samples \
  -H 'Content-Type: application/json' -d '{"id":"saas"}' -o /dev/null
DS=$(curl -fsS $BASE/api/datasets | node -pe \
  "JSON.parse(require('fs').readFileSync(0)).datasets[0].id")
curl -fsSN "$BASE/api/datasets/$(node -pe "encodeURIComponent('$DS')")/analyze" \
  | grep -c '^data:'          # должно быть несколько десятков событий

# 5. MCP отвечает
curl -fsS -X POST $BASE/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
       "protocolVersion":"2025-06-18","capabilities":{},
       "clientInfo":{"name":"probe","version":"1"}}}' | head -c 200
```

Если все пять шагов прошли — развёртывание рабочее.

---

## 8. Обновление

**Docker:**

```bash
cd /opt/agentics-analytics
git pull
docker compose up -d --build     # данные в томе не трогаются
```

**systemd:**

```bash
cd /opt/agentics-analytics
sudo git pull
sudo npm ci && sudo npm run build && sudo npm test && sudo npm prune --omit=dev
sudo systemctl restart agentics-analytics
```

Формат хранения — исходный файл плюс небольшой JSON с метаданными, поэтому
обновление версии не требует миграций.

---

## 9. Резервное копирование

Копировать нужно один каталог данных.

```bash
# systemd
sudo tar czf agentics-backup-$(date +%F).tar.gz -C /var/lib agentics-analytics

# Docker
docker run --rm -v agentics-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/agentics-backup-$(date +%F).tar.gz -C /data .
```

Восстановление — распаковать обратно в тот же каталог при остановленном
приложении. Наборы перечитываются при следующем старте.

---

## 10. Типичные проблемы

| Симптом | Причина и что делать |
|---|---|
| `порт 4173 уже занят` | Другой процесс на порту. `lsof -i :4173`, либо задайте `PORT`. |
| `не найден каталог веб-интерфейса` | Запуск из неверного каталога или не скопирован `src/web`. Укажите `AGENTICS_WEB_ROOT`. |
| Белая страница, в консоли 404 на `/app.js` | Фронтенд не попал в развёртывание. `src/web` должен лежать рядом с `dist/`. |
| Анализ «висит», прогресс не идёт | Прокси буферизует SSE. Нужен `proxy_buffering off` — см. п. 4. |
| «LLM не настроена» в шапке | Нет `ANTHROPIC_API_KEY`. Это не ошибка: анализ работает полностью, недоступны только формулировки и вопросы словами. |
| `413` при загрузке файла | Лимит прокси. Поднимите `client_max_body_size` до `64m`. |
| Контейнер `unhealthy` | `docker compose logs`. Чаще всего процесс не стартовал — смотрите первые строки лога. |
| Наборы пропали после перезапуска | Не подключён том или сменился `AGENTICS_DATA_DIR`. В Docker без `-v` данные живут только внутри контейнера. |
| Нехватка памяти на большом файле | Набор держится в памяти. Практический потолок — около 500 000 строк; поднимите лимит памяти или уменьшите выгрузку. |

Логи:

```bash
docker compose logs -f --tail=100          # Docker
journalctl -u agentics-analytics -f        # systemd
```

---

## 11. Безопасность: что стоит знать

- **Аутентификации нет.** Она сознательно вынесена на обратный прокси, а не
  сделана внутри: собственная реализация логинов в аналитическом инструменте —
  лишняя поверхность атаки там, где nginx решает задачу лучше.
- **Ключ модели** держите в файле с правами `600` или в секретнице
  оркестратора. В юнит systemd его класть нельзя — `systemctl cat` доступен
  всем пользователям.
- **Загружаемые данные** остаются на вашем сервере. Без `ANTHROPIC_API_KEY`
  наружу не уходит вообще ничего. С ключом во внешний вызов попадают только
  имена колонок, метаданные семантической модели и уже посчитанные числа
  находок — строки данных не передаются.
- **Известная уязвимость в зависимостях:** `npm audit` показывает moderate в
  `@hono/node-server` (транзитивная зависимость MCP SDK) — обход пути в
  `serve-static` под Windows. Этот код в приложении не используется: статика
  отдаётся собственным обработчиком с проверкой выхода за корень. Исправление
  требует ломающего понижения версии MCP SDK, поэтому оно не применено
  осознанно.
- Контейнер работает от непривилегированного пользователя, с
  `no-new-privileges` и записью только в том данных.
