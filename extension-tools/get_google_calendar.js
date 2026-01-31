/**
 * Extension tool: Google Calendar
 *
 * Fetches events from a Google Calendar using its public iCal URL.
 *
 * Setup:
 * 1. Go to Google Calendar settings
 * 2. Select your calendar
 * 3. Copy the "Secret address in iCal format" URL
 * 4. Replace CALENDAR_URL below with your URL
 *
 * Usage:
 * 1. Copy this file to your extension tools folder (configured in Sonar settings)
 * 2. Update CALENDAR_URL with your calendar's iCal URL
 * 3. Enable the tool in the chat interface
 *
 * @param {object} ctx - Context object provided by Sonar
 * @param {object} ctx.app - Obsidian App instance
 * @param {object} ctx.vault - Obsidian Vault instance
 * @param {function} ctx.requestUrl - Obsidian's requestUrl function for HTTP requests
 * @param {function} ctx.log - Log function
 * @param {function} ctx.warn - Warning function
 * @param {function} ctx.error - Error function
 */

// Replace with your Google Calendar iCal URL
const CALENDAR_URL = '';

function getTodayString() {
  return new Date().toISOString().split('T')[0];
}

function unescapeICalText(text) {
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function parseICalDate(value) {
  // Handle formats like:
  // 20240115T100000Z (UTC)
  // 20240115T100000 (local time)
  // 20240115 (all-day event)
  const cleaned = value.replace(/[^0-9TZ]/g, '');

  if (cleaned.length === 8) {
    // All-day event: YYYYMMDD
    const year = parseInt(cleaned.slice(0, 4));
    const month = parseInt(cleaned.slice(4, 6)) - 1;
    const day = parseInt(cleaned.slice(6, 8));
    return new Date(year, month, day);
  }

  // DateTime: YYYYMMDDTHHmmss or YYYYMMDDTHHmmssZ
  const year = parseInt(cleaned.slice(0, 4));
  const month = parseInt(cleaned.slice(4, 6)) - 1;
  const day = parseInt(cleaned.slice(6, 8));
  const hour = parseInt(cleaned.slice(9, 11));
  const minute = parseInt(cleaned.slice(11, 13));
  const second = parseInt(cleaned.slice(13, 15)) || 0;

  if (cleaned.endsWith('Z')) {
    return new Date(Date.UTC(year, month, day, hour, minute, second));
  }
  return new Date(year, month, day, hour, minute, second);
}

function applyFieldValue(event, field, value) {
  switch (field) {
    case 'SUMMARY':
      event.summary = unescapeICalText(value);
      break;
    case 'DESCRIPTION':
      event.description = unescapeICalText(value);
      break;
    case 'LOCATION':
      event.location = unescapeICalText(value);
      break;
    case 'DTSTART':
      event.start = parseICalDate(value);
      break;
    case 'DTEND':
      event.end = parseICalDate(value);
      break;
  }
}

function parseICalData(data) {
  const events = [];
  const lines = data.split(/\r?\n/);

  let currentEvent = null;
  let currentField = null;
  let currentValue = '';

  for (const line of lines) {
    // Handle line continuations (lines starting with space or tab)
    if (line.startsWith(' ') || line.startsWith('\t')) {
      currentValue += line.slice(1);
      continue;
    }

    // Process the previous field if we have one
    if (currentEvent && currentField) {
      applyFieldValue(currentEvent, currentField, currentValue);
    }

    // Parse the new line
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      currentField = null;
      currentValue = '';
      continue;
    }

    const fieldPart = line.slice(0, colonIndex);
    const value = line.slice(colonIndex + 1);

    // Extract the base field name (before any parameters like ;TZID=...)
    const fieldName = fieldPart.split(';')[0].toUpperCase();

    if (fieldName === 'BEGIN' && value.toUpperCase() === 'VEVENT') {
      currentEvent = {};
      currentField = null;
      currentValue = '';
    } else if (fieldName === 'END' && value.toUpperCase() === 'VEVENT') {
      if (currentEvent?.summary && currentEvent?.start && currentEvent?.end) {
        events.push(currentEvent);
      }
      currentEvent = null;
      currentField = null;
      currentValue = '';
    } else if (currentEvent) {
      currentField = fieldName;
      currentValue = value;
    }
  }

  return events;
}

function isSameDay(d1, d2) {
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  );
}

function formatEventDate(event) {
  const now = new Date();
  const isToday = isSameDay(event.start, now);
  const isTomorrow = isSameDay(
    event.start,
    new Date(now.getTime() + 24 * 60 * 60 * 1000)
  );

  const timeStr = event.start.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  if (isToday) {
    return `Today ${timeStr}`;
  } else if (isTomorrow) {
    return `Tomorrow ${timeStr}`;
  } else {
    const dateStr = event.start.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
    });
    return `${dateStr} ${timeStr}`;
  }
}

function formatEventsForContext(events) {
  if (events.length === 0) {
    return '';
  }

  const lines = ['[Google Calendar - Upcoming Events]'];

  for (const event of events) {
    const dateStr = formatEventDate(event);
    lines.push(`- ${dateStr}: ${event.summary}`);
    if (event.location) {
      lines.push(`  Location: ${event.location}`);
    }
    if (event.description) {
      const shortDesc = event.description.slice(0, 200);
      lines.push(
        `  ${shortDesc}${event.description.length > 200 ? '...' : ''}`
      );
    }
  }

  return lines.join('\n');
}

async function fetchEvents(requestUrl, startDate, endDate, log, warn) {
  if (!CALENDAR_URL) {
    log('No calendar URL configured');
    return [];
  }

  let icalData;
  try {
    const response = await requestUrl({ url: CALENDAR_URL });
    icalData = response.text;
  } catch (error) {
    warn(`Failed to fetch calendar: ${error}`);
    return [];
  }

  const events = parseICalData(icalData);

  // Parse date range
  const rangeStart = new Date(startDate);
  rangeStart.setHours(0, 0, 0, 0);

  const rangeEnd = new Date(endDate);
  rangeEnd.setHours(23, 59, 59, 999);

  const filtered = events.filter(
    e => e.start >= rangeStart && e.start <= rangeEnd
  );
  filtered.sort((a, b) => a.start.getTime() - b.start.getTime());

  log(`Fetched ${filtered.length} events (${startDate} to ${endDate})`);
  return filtered;
}

/** @param {import('./types').ExtensionToolContext} ctx */
module.exports = function (ctx) {
  /** @type {import('./types').ExtensionTool} */
  const tool = {
    definition: {
      name: 'get_google_calendar',
      description:
        'Get events from Google Calendar for a specified date range. ' +
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
    displayName: 'Google calendar',
    defaultDisabled: true,
    execute: async args => {
      const startDate = args.start_date || getTodayString();
      const endDate = args.end_date || getTodayString();

      const events = await fetchEvents(
        ctx.requestUrl,
        startDate,
        endDate,
        ctx.log,
        ctx.warn
      );

      if (events.length === 0) {
        return `No events found from ${startDate} to ${endDate}.`;
      }

      return formatEventsForContext(events);
    },
  };
  return tool;
};
