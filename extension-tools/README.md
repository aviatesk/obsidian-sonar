# Extension tools

Create custom tools for the agentic assistant chat by placing JavaScript files
in this folder (or any folder you configure in **Settings → Sonar → Extension
tools folder**).

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

## Type definitions

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

## Examples

See the example tools in this folder:

- `get_google_calendar.js` - Fetches events from Google Calendar via iCal URL
- `get_tasks.js` - Integrates with the
  [Tasks calendar](https://github.com/aviatesk/obsidian-tasks-calendar) plugin
