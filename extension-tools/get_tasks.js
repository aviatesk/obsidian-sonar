/**
 * Extension tool: Tasks Calendar
 *
 * Integrates with the tasks-calendar Obsidian plugin to retrieve tasks.
 * This tool uses the Dataview API through tasks-calendar to query tasks
 * from your vault.
 *
 * Prerequisites:
 * - tasks-calendar plugin installed and configured
 * - Dataview plugin installed
 *
 * Usage:
 * 1. Copy this file to your extension tools folder (configured in Sonar settings)
 * 2. Enable the tool in the chat interface
 *
 * @param {object} ctx - Context object provided by Sonar
 * @param {object} ctx.app - Obsidian App instance
 * @param {object} ctx.vault - Obsidian Vault instance
 * @param {function} ctx.log - Log function
 * @param {function} ctx.warn - Warning function
 * @param {function} ctx.error - Error function
 */

const DEFAULT_SETTINGS = {
  query: '""',
  dateProperty: 'due',
  startDateProperty: 'start',
  excludedStatuses: ['x', 'X', '-'],
  includedStatuses: [],
  excludedTags: [],
  includedTags: [],
};

function getTodayString() {
  return new Date().toISOString().split('T')[0];
}

function getTasksCalendarPlugin(app, log) {
  const plugin = app.plugins?.plugins?.['tasks-calendar'];
  if (!plugin) {
    log('tasks-calendar plugin not found');
    return null;
  }
  return plugin;
}

function normalizeTag(tag) {
  return tag.startsWith('#') ? tag : `#${tag}`;
}

function parseDate(value) {
  if (!value) return null;

  // Handle Luxon DateTime objects (from Dataview)
  if (
    typeof value === 'object' &&
    value !== null &&
    'isLuxonDateTime' in value
  ) {
    if (value.isValid) {
      return value.toJSDate();
    }
    return null;
  }

  // Handle string dates
  if (typeof value === 'string') {
    const date = new Date(value);
    if (!isNaN(date.getTime())) {
      return date;
    }
  }

  // Handle Date objects
  if (value instanceof Date) {
    return value;
  }

  return null;
}

function getPageDate(page, property) {
  const frontmatter = page.file.frontmatter;
  if (!frontmatter || !frontmatter[property]) return null;
  return parseDate(frontmatter[property]);
}

function getTaskDate(task, property) {
  const value = task[property];
  if (!value) return null;
  return parseDate(value);
}

function isAllDay(date) {
  return (
    date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0
  );
}

function cleanTaskText(text) {
  return text
    .replace(/#\w+/g, '') // Remove tags
    .replace(/\[[\w\s-]+::\s*[^\]]*\]/g, '') // Remove [key:: value] metadata
    .trim();
}

function shouldIncludeSource(source, settings, isPage) {
  const status = source.status;

  // Check excluded statuses
  if (
    settings.excludedStatuses.length &&
    status &&
    settings.excludedStatuses.includes(status)
  ) {
    return false;
  }

  // Check included statuses
  if (
    settings.includedStatuses.length &&
    (!status || !settings.includedStatuses.includes(status))
  ) {
    return false;
  }

  // Check excluded tags
  const tags = source.tags || [];
  if (settings.excludedTags.length) {
    const normalizedTags = tags.map(t => normalizeTag(t));
    if (
      normalizedTags.some(tag =>
        settings.excludedTags.includes(normalizeTag(tag))
      )
    ) {
      return false;
    }
  }

  // Check included tags
  if (settings.includedTags.length) {
    const normalizedTags = tags.map(t => normalizeTag(t));
    if (
      !settings.includedTags.some(tag =>
        normalizedTags.includes(normalizeTag(tag))
      )
    ) {
      return false;
    }
  }

  // Check date property exists
  const dateProperty = settings.dateProperty || DEFAULT_SETTINGS.dateProperty;
  const date = isPage
    ? getPageDate(source, dateProperty)
    : getTaskDate(source, dateProperty);
  if (!date) return false;

  return true;
}

function createEventFromSource(source, settings, isPage) {
  const dateProperty = settings.dateProperty || DEFAULT_SETTINGS.dateProperty;
  const startDateProperty =
    settings.startDateProperty || DEFAULT_SETTINGS.startDateProperty;

  const dueDate = isPage
    ? getPageDate(source, dateProperty)
    : getTaskDate(source, dateProperty);
  if (!dueDate) return null;

  let startDate = dueDate;
  let endDate = undefined;
  let allDay = isAllDay(dueDate);

  // Check for start date
  const taskStartDate = isPage
    ? getPageDate(source, startDateProperty)
    : getTaskDate(source, startDateProperty);

  if (taskStartDate) {
    startDate = taskStartDate;
    endDate = dueDate;
    if (allDay && isAllDay(taskStartDate)) {
      // For all-day events, end date should be exclusive (next day)
      endDate = new Date(dueDate.getTime() + 24 * 60 * 60 * 1000);
    } else {
      allDay = false;
    }
  }

  const taskText = isPage ? source.file.name : source.text;
  const cleanText = cleanTaskText(taskText);
  const filePath = isPage ? source.file.path : source.path;

  return {
    title: cleanText,
    start: startDate,
    end: endDate,
    allDay,
    status: source.status || ' ',
    filePath,
    tags: source.tags || [],
  };
}

function formatEventDate(event) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const eventDay = new Date(
    event.start.getFullYear(),
    event.start.getMonth(),
    event.start.getDate()
  );
  const daysDiff = Math.round(
    (eventDay.getTime() - today.getTime()) / (24 * 60 * 60 * 1000)
  );

  let dateStr;
  if (daysDiff === 0) {
    dateStr = 'Today';
  } else if (daysDiff === 1) {
    dateStr = 'Tomorrow';
  } else if (daysDiff === -1) {
    dateStr = 'Yesterday';
  } else if (daysDiff < -1) {
    dateStr = `${Math.abs(daysDiff)} days ago`;
  } else {
    dateStr = event.start.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
    });
  }

  if (!event.allDay) {
    const timeStr = event.start.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    dateStr += ` ${timeStr}`;
  }

  return dateStr;
}

function getStatusIcon(status) {
  switch (status) {
    case ' ':
      return '[ ]';
    case 'x':
    case 'X':
      return '[x]';
    case '/':
      return '[/]';
    case '-':
      return '[-]';
    case '>':
      return '[>]';
    case '!':
      return '[!]';
    case '?':
      return '[?]';
    default:
      return `[${status}]`;
  }
}

function formatWikilink(filePath) {
  const noteName = filePath.replace(/\.md$/, '');
  return `[[${noteName}]]`;
}

function formatEventsForContext(events) {
  if (events.length === 0) {
    return '';
  }

  const lines = ['[Tasks Calendar - Upcoming Tasks]'];

  for (const event of events) {
    const dateStr = formatEventDate(event);
    const statusIcon = getStatusIcon(event.status);
    const wikilink = formatWikilink(event.filePath);
    lines.push(`- ${statusIcon} ${dateStr}: ${event.title} (${wikilink})`);
    if (event.tags.length > 0) {
      lines.push(`  Tags: ${event.tags.join(', ')}`);
    }
  }

  return lines.join('\n');
}

async function fetchEvents(app, startDate, endDate, log, warn) {
  const tasksPlugin = getTasksCalendarPlugin(app, log);
  if (!tasksPlugin) {
    return [];
  }

  const dataviewApi = tasksPlugin.dataviewApi;
  if (!dataviewApi) {
    warn('Dataview API not available');
    return [];
  }

  let settings;
  try {
    settings = tasksPlugin.configManager.getCalendarSettings();
  } catch {
    warn('Failed to get calendar settings, using defaults');
    settings = DEFAULT_SETTINGS;
  }

  const events = [];
  const query = settings.query || DEFAULT_SETTINGS.query;

  dataviewApi.pages(query).forEach(page => {
    // Check page-level events (from frontmatter)
    if (shouldIncludeSource(page, settings, true)) {
      const event = createEventFromSource(page, settings, true);
      if (event) events.push(event);
    }

    // Check tasks within the page
    if (page.file.tasks) {
      for (const task of page.file.tasks) {
        if (shouldIncludeSource(task, settings, false)) {
          const event = createEventFromSource(task, settings, false);
          if (event) events.push(event);
        }
      }
    }
  });

  // Parse date range
  const rangeStart = new Date(startDate);
  rangeStart.setHours(0, 0, 0, 0);

  const rangeEnd = new Date(endDate);
  rangeEnd.setHours(23, 59, 59, 999);

  const filtered = events.filter(
    e => e.start >= rangeStart && e.start <= rangeEnd
  );
  filtered.sort((a, b) => a.start.getTime() - b.start.getTime());

  log(`Fetched ${filtered.length} tasks (${startDate} to ${endDate})`);
  return filtered;
}

/** @param {import('./types').ExtensionToolContext} ctx */
module.exports = function (ctx) {
  /** @type {import('./types').ExtensionTool} */
  const tool = {
    definition: {
      name: 'get_tasks',
      description:
        'Get tasks from the vault for a specified date range. ' +
        'Dates should be in YYYY-MM-DD format.',
      parameters: {
        type: 'object',
        properties: {
          start_date: {
            type: 'string',
            description: 'Start date in YYYY-MM-DD format',
          },
          end_date: {
            type: 'string',
            description: 'End date in YYYY-MM-DD format (inclusive)',
          },
        },
        required: ['start_date', 'end_date'],
      },
    },
    displayName: 'Tasks calendar',
    defaultDisabled: true,
    execute: async args => {
      const startDate = args.start_date || getTodayString();
      const endDate = args.end_date || getTodayString();

      const events = await fetchEvents(
        ctx.app,
        startDate,
        endDate,
        ctx.log,
        ctx.warn
      );

      if (events.length === 0) {
        return `No tasks found from ${startDate} to ${endDate}.`;
      }

      return formatEventsForContext(events);
    },
  };
  return tool;
};
