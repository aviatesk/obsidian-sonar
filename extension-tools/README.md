# Sonar chat extension tools

This folder contains documentation for the extension tool [API](#api) and
[example tools](#example-extension-tools). To use extension tools:

1. Configure **Settings → Sonar → Chat → Extension tools → Extension tools
   folder** to point to a folder in your vault
2. Copy the desired tool scripts (`.js` files) from this folder to your
   configured folder
3. Edit the copied scripts to add your configuration (API keys, URLs, etc.)
4. Enable the tools in the chat interface

## API

Each tool file should export a function that receives a context object and
returns a tool definition:

```javascript
module.exports = function (ctx) {
  return {
    definition: {
      name: 'my_tool',
      description: 'Description shown to the LLM',
      parameters: {
        type: 'object',
        properties: {
          param1: {
            type: 'string',
            description: 'Parameter description',
          },
        },
        required: ['param1'],
      },
    },
    displayName: 'My Tool',
    execute: async args => {
      // args contains the parameters from the LLM
      return 'Result string returned to the LLM';
    },
  };
};
```

### Context object

The `ctx` object provides access to Obsidian APIs, logging, and plugin
resources:

| Property         | Description                                        |
| ---------------- | -------------------------------------------------- |
| `ctx.app`        | Obsidian App instance                              |
| `ctx.vault`      | Obsidian Vault instance                            |
| `ctx.requestUrl` | Obsidian's `requestUrl` function for HTTP requests |
| `ctx.log`        | Log function (info level)                          |
| `ctx.warn`       | Warning function                                   |
| `ctx.error`      | Error function                                     |
| `ctx.plugin`     | Plugin resources (see below)                       |

#### Plugin resources

The `ctx.plugin` object provides access to Sonar's internal components:

| Property                      | Description                                    |
| ----------------------------- | ---------------------------------------------- |
| `ctx.plugin.getSearchManager` | Returns `SearchManager` or `null` if not ready |
| `ctx.plugin.getMetadataStore` | Returns `MetadataStore` or `null` if not ready |

### Tool definition

The `definition` object follows the
[OpenAI function calling format](https://platform.openai.com/docs/guides/function-calling):

- `name`: Tool identifier (used by the LLM to call the tool)
- `description`: Explains what the tool does (helps the LLM decide when to use
  it)
- `parameters`: JSON Schema defining the tool's parameters

### Execute function

The `execute` function receives the parsed arguments from the LLM and should
return a string result. Use `async/await` for asynchronous operations.

### Availability check

The optional `getUnavailableReason` function allows you to dynamically control
when your tool is available to the LLM:

- Return `undefined` (or omit the function): Tool is available
- Return a string: Tool is unavailable, and the string explains why

This is useful when your tool depends on external services, specific
configurations, or other conditions that may not always be met.

### Type definitions

A `types.d.ts` file is provided for TypeScript users or for JSDoc type hints in
JavaScript. You can reference types using JSDoc comments:

```javascript
/** @param {import('./types').ExtensionToolContext} ctx */
module.exports = function (ctx) {
  /** @type {import('./types').ExtensionTool} */
  const tool = {
    definition: {
      /* ... */
    },
    displayName: 'My Tool',
    execute: async args => {
      /* ... */
    },
  };
  return tool;
};
```

This enables IDE autocompletion and type checking even in plain JavaScript
files.

## Example extension tools

This folder includes several ready-to-use extension tools. To use them, copy the
desired tool to your extension tools folder and configure as needed.

### SearXNG search ([`searxng_search.js`](./searxng_search.js))

Search the web using a self-hosted [SearXNG](https://github.com/searxng/searxng)
instance. SearXNG is a privacy-respecting metasearch engine that aggregates
results from multiple search engines without tracking.

**Setup:**

1. Install SearXNG using Docker:

   ```bash
   mkdir -p ~/searxng
   cat > ~/searxng/settings.yml << 'EOF'
   use_default_settings: true

   server:
     limiter: false
     secret_key: "change-this-to-random-string"

   search:
     formats:
       - html
       - json
   EOF

   docker run -d -p 8080:8080 --name searxng \
     -v ~/searxng/settings.yml:/etc/searxng/settings.yml:ro \
     searxng/searxng
   ```

2. Test the setup:

   ```bash
   curl "http://localhost:8080/search?q=test&format=json"
   ```

3. Edit `searxng_search.js` and set `SEARXNG_URL` to your instance URL:

   ```javascript
   const SEARXNG_URL = 'http://localhost:8080';
   ```

4. Enable the tool in the chat interface

### Google Calendar ([`get_google_calendar.js`](./get_google_calendar.js))

Fetch events from a Google Calendar using its public iCal URL.

**Setup:**

1. Go to
   [Google Calendar settings](https://calendar.google.com/calendar/r/settings)
2. Select your calendar from the left sidebar
3. Scroll to "Integrate calendar" and copy the "Secret address in iCal format"
4. Edit `get_google_calendar.js` and set `CALENDAR_URL`:

   ```javascript
   const CALENDAR_URL = 'https://calendar.google.com/calendar/ical/...';
   ```

5. Enable the tool in the chat interface

### Tasks Calendar ([`get_tasks.js`](./get_tasks.js))

Integrate with the
[Tasks Calendar](https://github.com/aviatesk/obsidian-tasks-calendar) plugin to
fetch tasks with due dates.

**Setup:**

1. Install and configure the Tasks Calendar plugin
2. Copy `get_tasks.js` to your extension tools folder
3. Enable the tool in the chat interface

The tool will automatically find tasks with due dates in your vault using the
Tasks Calendar plugin's data.
