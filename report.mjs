import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

loadDotEnv(path.join(__dirname, '.env'));

const CONFIG = {
  webhookUrl: requireEnv('BITRIX24_WEBHOOK_URL').replace(/\/+$/, ''),
  funnelName: process.env.BITRIX24_FUNNEL_NAME || 'КПК - СПб',
  recipientUserId: process.env.BITRIX24_REPORT_RECIPIENT_USER_ID || '123874',
  reportTime: process.env.BITRIX24_REPORT_TIME || '10:20',
  timezone: process.env.BITRIX24_TIMEZONE || 'Europe/Moscow',
  requestTimeoutMs: Number(process.env.BITRIX24_REQUEST_TIMEOUT_MS || 20000),
  includeFinalStages: parseBoolean(process.env.BITRIX24_INCLUDE_FINAL_STAGES, false),
  onlyOpenDeals: parseBoolean(process.env.BITRIX24_ONLY_OPEN_DEALS, true),
  maxDealPages: Number(process.env.BITRIX24_MAX_DEAL_PAGES || 200),
  showZeroStages: parseBoolean(process.env.BITRIX24_SHOW_ZERO_STAGES, false),
  deliveryMethod: process.env.BITRIX24_DELIVERY_METHOD || 'message',
  verbose: parseBoolean(process.env.BITRIX24_VERBOSE, false),
  dryRun: parseBoolean(process.env.BITRIX24_DRY_RUN, false)
};

async function main() {
  const categories = await bitrixCall('crm.category.list', { entityTypeId: 2 });
  const funnel = findFunnel(categories);
  const stages = await fetchDealStages(funnel.id);
  const reportStages = CONFIG.includeFinalStages ? stages : stages.filter((stage) => !isFinalStage(stage));
  const deals = await fetchDeals(funnel.id);
  const reportDeals = CONFIG.includeFinalStages ? deals : deals.filter((deal) => {
    const stage = reportStages.find((item) => item.id === deal.STAGE_ID);
    return Boolean(stage);
  });
  const userIds = unique(reportDeals.map((deal) => String(deal.ASSIGNED_BY_ID || '')).filter(Boolean));
  const usersById = await fetchUsersById(userIds);
  const report = buildReport({
    funnel,
    stages: reportStages,
    deals: reportDeals,
    usersById,
    generatedAt: new Date()
  });

  if (CONFIG.dryRun) {
    console.log(report);
    return;
  }

  await sendReport(report);
  console.log(`Bitrix24 funnel report sent to user ${CONFIG.recipientUserId}.`);
}

function findFunnel(payload) {
  const categories = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.categories)
      ? payload.categories
      : [];
  const normalizedTarget = normalize(CONFIG.funnelName);
  const funnel = categories.find((item) => normalize(item.name) === normalizedTarget);

  if (!funnel) {
    const available = categories.map((item) => `${item.id}: ${item.name}`).join('\n');
    throw new Error(`Воронка "${CONFIG.funnelName}" не найдена. Доступные воронки:\n${available}`);
  }

  return {
    id: Number(funnel.id),
    name: funnel.name
  };
}

async function fetchDealStages(categoryId) {
  const entityId = Number(categoryId) > 0 ? `DEAL_STAGE_${categoryId}` : 'DEAL_STAGE';
  const result = await bitrixCall('crm.status.list', {
    order: { SORT: 'ASC' },
    filter: { ENTITY_ID: entityId }
  });

  return (Array.isArray(result) ? result : []).map((stage) => ({
    id: String(stage.STATUS_ID || ''),
    name: String(stage.NAME || stage.NAME_INIT || stage.STATUS_ID || ''),
    sort: Number(stage.SORT || 0),
    semantics: String(stage.SEMANTICS || stage.EXTRA?.SEMANTICS || '').toUpperCase()
  })).filter((stage) => stage.id);
}

async function fetchDeals(categoryId) {
  const deals = [];
  let start = 0;
  let page = 0;

  while (true) {
    page += 1;
    if (page > CONFIG.maxDealPages) {
      throw new Error(`Остановлено после ${CONFIG.maxDealPages} страниц сделок. Проверьте фильтр воронки или увеличьте BITRIX24_MAX_DEAL_PAGES.`);
    }

    const filter = { CATEGORY_ID: categoryId };
    if (CONFIG.onlyOpenDeals) {
      filter.CLOSED = 'N';
    }

    const response = await bitrixCallRaw('crm.deal.list', {
      ORDER: { ID: 'ASC' },
      FILTER: filter,
      SELECT: ['ID', 'TITLE', 'CATEGORY_ID', 'STAGE_ID', 'ASSIGNED_BY_ID', 'CLOSED'],
      start
    });

    const rows = Array.isArray(response.result) ? response.result : [];
    deals.push(...rows);

    if (response.next === undefined || response.next === null) {
      break;
    }

    const next = Number(response.next);
    if (!Number.isFinite(next) || next <= start) {
      break;
    }

    start = next;
  }

  return deals;
}

async function fetchUsersById(userIds) {
  const usersById = {};

  if (userIds.length === 0) {
    return usersById;
  }

  for (const chunk of chunkArray(userIds, 50)) {
    const result = await bitrixCall('user.get', {
      FILTER: { ID: chunk },
      SELECT: ['ID', 'NAME', 'LAST_NAME', 'SECOND_NAME', 'ACTIVE']
    });

    (Array.isArray(result) ? result : []).forEach((user) => {
      const id = String(user.ID || '');
      const name = [user.LAST_NAME, user.NAME, user.SECOND_NAME].filter(Boolean).join(' ').trim();
      usersById[id] = name || `Пользователь ${id}`;
    });
  }

  return usersById;
}

function buildReport({ funnel, stages, deals, usersById, generatedAt }) {
  const grouped = {};
  const stageById = Object.fromEntries(stages.map((stage) => [stage.id, stage]));

  deals.forEach((deal) => {
    const userId = String(deal.ASSIGNED_BY_ID || '0');
    const stageId = String(deal.STAGE_ID || '');

    if (!stageById[stageId]) {
      return;
    }

    if (!grouped[userId]) {
      grouped[userId] = {
        userId,
        name: usersById[userId] || `Пользователь ${userId}`,
        total: 0,
        stages: {}
      };
    }

    grouped[userId].total += 1;
    grouped[userId].stages[stageId] = (grouped[userId].stages[stageId] || 0) + 1;
  });

  const periodTitle = isMondayInMoscow(generatedAt)
    ? 'за выходные и утро понедельника'
    : 'на утро';
  const lines = [
    `Аналитика по воронке "${funnel.name}" ${periodTitle}`,
    `Время отчёта: ${formatDateTime(generatedAt)} МСК`,
    `Всего сделок: ${deals.length}`,
    ''
  ];

  const assignees = Object.values(grouped).sort((left, right) => {
    if (right.total !== left.total) {
      return right.total - left.total;
    }

    return left.name.localeCompare(right.name, 'ru');
  });

  if (assignees.length === 0) {
    lines.push('Активных сделок в выбранной воронке не найдено.');
    return lines.join('\n');
  }

  assignees.forEach((assignee, index) => {
    if (index > 0) {
      lines.push('');
    }

    lines.push(`${assignee.name} — ${assignee.total}`);

    stages.forEach((stage) => {
      const count = assignee.stages[stage.id] || 0;
      if (count > 0 || CONFIG.showZeroStages) {
        lines.push(`${stage.name}: ${count}`);
      }
    });
  });

  return lines.join('\n');
}

async function sendReport(report) {
  if (CONFIG.deliveryMethod === 'notify') {
    await bitrixCall('im.notify.system.add', {
      USER_ID: CONFIG.recipientUserId,
      MESSAGE: report,
      MESSAGE_OUT: report,
      TAG: `daily_funnel_${new Date().toISOString().slice(0, 10)}`,
      SUB_TAG: 'daily_funnel_report'
    });
    return;
  }

  try {
    await bitrixCall('im.message.add', {
      DIALOG_ID: String(CONFIG.recipientUserId),
      MESSAGE: report,
      SYSTEM: 'N',
      URL_PREVIEW: 'N'
    });
  } catch (error) {
    console.warn(`im.message.add failed, trying im.notify.system.add: ${error.message}`);
    await bitrixCall('im.notify.system.add', {
      USER_ID: CONFIG.recipientUserId,
      MESSAGE: report,
      MESSAGE_OUT: report,
      TAG: `daily_funnel_${new Date().toISOString().slice(0, 10)}`,
      SUB_TAG: 'daily_funnel_report'
    });
  }
}

async function bitrixCall(method, params) {
  const payload = await bitrixCallRaw(method, params);
  return payload.result;
}

async function bitrixCallRaw(method, params) {
  if (CONFIG.verbose) {
    console.error(`Calling ${method}...`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
  let response;

  try {
    response = await fetch(`${CONFIG.webhookUrl}/${method}.json`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(params || {}),
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Bitrix24 ${method} timeout after ${CONFIG.requestTimeoutMs} ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok || payload.error) {
    const description = payload.error_description || payload.error || text || response.statusText;
    throw new Error(`Bitrix24 ${method} error: ${description}`);
  }

  return payload;
}

function isFinalStage(stage) {
  return ['S', 'F', 'SUCCESS', 'FAILURE'].includes(stage.semantics);
}

function formatDateTime(date) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: CONFIG.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function isMondayInMoscow(date) {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: CONFIG.timezone,
    weekday: 'short'
  }).format(date);
  return weekday === 'Mon';
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Не задана переменная окружения ${name}.`);
  }

  return value;
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === '') {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

function normalize(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function unique(values) {
  return [...new Set(values)];
}

function chunkArray(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }

    const separator = trimmed.indexOf('=');
    if (separator < 0) {
      return;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  });
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
