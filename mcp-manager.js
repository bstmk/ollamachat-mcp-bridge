'use strict';

/**
 * mcp-manager.js
 * Manages all MCP child processes defined in the config.
 * Aggregates tool lists (with server-prefix namespacing) and
 * routes tool calls to the correct process.
 * Includes built-in tools (Brave Search) that don't need an MCP server.
 */

const McpProcess = require('./mcp-process');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── .env loader ─────────────────────────────────────────────────────────────
const ENV_FILE = path.join(__dirname, '.env');

function loadEnv() {
  try {
    const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) process.env[match[1].trim()] = match[2].trim();
    }
  } catch (_) { /* no .env yet, that's fine */ }
}
loadEnv();

const SERVER_PREFIX_SEP = '__';
const OSAURUS_URL = process.env.OSAURUS_URL || 'http://127.0.0.1:1337';
let osaurusKey = process.env.OSAURUS_ACCESS_KEY || '';
let osaurusToolsCache = null;
let osaurusToolsCacheTime = 0;
const OSAURUS_CACHE_TTL = 300000; // 5 minutes

// ─── Built-in tools (no MCP server needed) ────────────────────────────────────

const BRAVE_API_KEY = process.env.BRAVE_SEARCH_API_KEY || '';
let braveKey = BRAVE_API_KEY; // mutable runtime override

// Historical tool metadata. Nothing below is registered or dispatched.
// callTool only forwards peekaboo__ names that the policy allowlist accepts.
const BUILTIN_TOOLS = [
  {
    name: 'builtin__web_search',
    description: 'Search the web using Brave Search. Returns titles, URLs, and descriptions of top results. Use this for any question about current events, prices, news, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query',
        },
        count: {
          type: 'number',
          description: 'Number of results to return (default 5, max 20)',
        },
      },
      required: ['query'],
    },
    server: 'builtin',
  },
  {
    name: 'builtin__weather_search',
    description: 'Get current weather conditions and forecast for a location. Use this for any question about current temperature, humidity, wind, or weather forecast.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Location to get weather for, e.g. "Waynesboro, PA" or "Gettysburg, Pennsylvania"',
        },
      },
      required: ['query'],
    },
    server: 'builtin',
  },
  {
    name: 'builtin__crypto_price',
    description: 'Get current cryptocurrency prices in USD or other currencies. Use when asked about Bitcoin, Ethereum, Solana, or any crypto price.',
    inputSchema: {
      type: 'object',
      properties: {
        coins: {
          type: 'string',
          description: 'Comma-separated coin IDs, e.g. "bitcoin,ethereum,solana". Common IDs: bitcoin, ethereum, solana, cardano, dogecoin, xrp, polkadot, avalanche, chainlink, litecoin',
        },
        currency: {
          type: 'string',
          description: 'Currency code (default: usd). Supports usd, eur, gbp, jpy, cny, etc.',
        },
      },
      required: ['coins'],
    },
    server: 'builtin',
  },
  {
    name: 'builtin__shopping_list_to_pantry',
    description: 'Transfer all items from the Shopping List to the pantry. Fetches items from the Shopping List reminder, adds each to the pantry inventory, then marks them complete on the list. Use when the user says "add shopping list to pantry", "move shopping list to pantry", "I went shopping", or similar.',
    inputSchema: {
      type: 'object',
      properties: {
        listName: {
          type: 'string',
          description: 'Name of the reminder list to transfer from (default: "Shopping List")',
        },
        clearList: {
          type: 'boolean',
          description: 'Whether to mark items as complete on the shopping list after adding to pantry (default: true)',
        },
      },
      required: [],
    },
    server: 'builtin',
  },
  {
    name: 'builtin__organize_shopping_list',
    description: 'Organize shopping list items by grocery store section (Produce, Dairy, Meat, Bakery, Frozen, Canned/Dry, Condiments, Spices, Beverages, etc.). Returns items grouped by section for efficient shopping. Use when user says "organize my list", "sort by aisle", "make a shopping plan", or similar.',
    inputSchema: {
      type: 'object',
      properties: {
        listName: {
          type: 'string',
          description: 'Name of the reminder list to organize (default: "Shopping List")',
        },
        saveAsNote: {
          type: 'boolean',
          description: 'Save the organized list as an Apple Note with checkboxes for offline use (default: false)',
        },
      },
      required: [],
    },
    server: 'builtin',
  },
  {
    name: 'builtin__get_shopping_list',
    description: 'Get the current shopping list items. Returns just the item names — clean and easy to read. Use when the user asks what is on their shopping list, grocery list, or what they need to buy.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    server: 'builtin',
  },
  // ── Reminders tools (replacing Osaurus) ──
  {
    name: 'builtin__get_reminders',
    description: 'Get reminders, optionally filtered by list name. Returns title, completion status, due date, and notes for each reminder. Use when the user asks about their reminders, to-do items, or what they need to do.',
    inputSchema: {
      type: 'object',
      properties: {
        listName: {
          type: 'string',
          description: 'Filter by reminder list name (e.g. "Shopping List", "Work"). Omit to get reminders from all lists.',
        },
        includeCompleted: {
          type: 'boolean',
          description: 'Include completed reminders (default: false)',
        },
      },
      required: [],
    },
    server: 'builtin',
  },
  {
    name: 'builtin__get_lists',
    description: 'Get the names of all reminder lists. Use when the user asks what lists they have or wants to see available reminder lists.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    server: 'builtin',
  },
  {
    name: 'builtin__create_reminder',
    description: 'Create a new reminder. Use when the user asks to add a reminder, set a to-do, or remember something.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'The reminder title / text',
        },
        listName: {
          type: 'string',
          description: 'List to add the reminder to (default: "Reminders")',
        },
        notes: {
          type: 'string',
          description: 'Additional notes for the reminder',
        },
      },
      required: ['title'],
    },
    server: 'builtin',
  },
  {
    name: 'builtin__search_reminders',
    description: 'Search reminders by title. Use when the user asks to find a specific reminder or asks "do I have a reminder about..."',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text to search for in reminder titles',
        },
      },
      required: ['query'],
    },
    server: 'builtin',
  },
  {
    name: 'builtin__open_reminder',
    description: 'Open the Reminders app. Use when the user says "open reminders" or wants to see their reminders visually.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    server: 'builtin',
  },
  // ── Notes tools ──
  {
    name: 'builtin__list_notes',
    description: 'List recent notes from Apple Notes. Use when the user asks what notes they have, to see their notes, or find a specific note.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    server: 'builtin',
  },
  // ── Filesystem tools ──
  {
    name: 'builtin__list_directory',
    description: 'List contents of a directory on the Mac. Use when the user asks what files are in a folder, or wants to browse directories.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to list (default: current directory)',
        },
      },
      required: [],
    },
    server: 'builtin',
  },
];

function toolDenied() {
  const err = new Error('Tool denied');
  err.statusCode = 403;
  err.denied = true;
  return err;
}

async function executeBuiltinTool(_toolName, _args, _manager) {
  throw toolDenied();
}


async function fetchOsaurusTools() {
  if (osaurusToolsCache && (Date.now() - osaurusToolsCacheTime) < OSAURUS_CACHE_TTL) {
    return osaurusToolsCache;
  }
  if (!osaurusKey) {
    console.warn(`[${ts()}] [manager] Osaurus key not configured, skipping Osaurus tools`);
    return [];
  }
  try {
    const result = await httpGet(`${OSAURUS_URL}/mcp/tools`, {
      'Authorization': `Bearer ${osaurusKey}`,
      'Accept': 'application/json',
    });
    const data = JSON.parse(result);
    const tools = data.tools || [];
    osaurusToolsCache = tools;
    osaurusToolsCacheTime = Date.now();
    console.log(`[${ts()}] [manager] Fetched ${tools.length} Osaurus tools`);
    return tools;
  } catch (err) {
    console.error(`[${ts()}] [manager] Failed to fetch Osaurus tools: ${err.message}`);
    return osaurusToolsCache || []; // return stale cache if available
  }
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? require('https') : require('http');
    lib.get(url, { headers, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        } else {
          resolve(data);
        }
      });
    }).on('error', reject);
  });
}

function httpPostJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? require('https') : require('http');
    const bodyStr = JSON.stringify(body);
    const allHeaders = { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) };
    const req = lib.request(url, { method: 'POST', headers: allHeaders, timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ content: [{ type: 'text', text: data }], isError: res.statusCode >= 400 });
        }
      });
    });
    req.on('error', (err) => resolve({ content: [{ type: 'text', text: `Osaurus proxy error: ${err.message}` }], isError: true }));
    req.write(bodyStr);
    req.end();
  });
}

function getOsaurusKey() { return osaurusKey; }
function setOsaurusKey(_key) {
  throw toolDenied();
}

function getBraveKey() { return braveKey; }
function setBraveKey(_key) {
  throw toolDenied();
}

function braveSearch(query, count) {
  return new Promise((resolve, reject) => {
    if (!braveKey) {
      return resolve({
        content: [{ type: 'text', text: 'Brave Search API key not configured. Set BRAVE_SEARCH_API_KEY environment variable.' }],
        isError: true,
      });
    }

    const params = new URLSearchParams({ q: query, count: String(Math.min(count, 20)) });
    const url = `https://api.search.brave.com/res/v1/web/search?${params}`;

    const req = https.get(url, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': braveKey,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            return resolve({
              content: [{ type: 'text', text: `Brave Search error: HTTP ${res.statusCode} — ${data}` }],
              isError: true,
            });
          }
          const json = JSON.parse(data);
          const results = (json.web?.results || []).slice(0, count).map((r, i) => (
            `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description || ''}`
          ));
          const text = results.length > 0
            ? `Search results for "${query}":\n\n${results.join('\n\n')}`
            : `No results found for "${query}"`;
          resolve({
            content: [{ type: 'text', text }],
            isError: false,
          });
        } catch (err) {
          resolve({
            content: [{ type: 'text', text: `Failed to parse Brave Search response: ${err.message}` }],
            isError: true,
          });
        }
      });
    });

    req.on('error', (err) => {
      resolve({
        content: [{ type: 'text', text: `Brave Search request failed: ${err.message}` }],
        isError: true,
      });
    });

    req.setTimeout(15000, () => {
      req.destroy();
      resolve({
        content: [{ type: 'text', text: 'Brave Search request timed out' }],
        isError: true,
      });
    });
  });
}

function weatherSearch(location) {
  return new Promise((resolve) => {
    // Extract location from natural language queries like "weather in Waynesboro, PA"
    let query = location;
    const patterns = [
      /weather (?:in|for|at|near) (.+)/i,
      /(.+?)\s+weather/i,
      /(?:current|today'?s?)\s+weather\s+(?:in|for|at|near)?\s*(.+)/i,
      /what(?:'?s| is) the weather (?:in|for|at|near) (.+)/i,
    ];
    for (const p of patterns) {
      const m = query.match(p);
      if (m && m[1] && m[1].length > 3) {
        query = m[1].replace(/[?!.]+$/, '').trim();
        break;
      }
    }

    // Step 1: Geocode the location (Nominatim — better US coverage than Open-Meteo)
    const geoUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&accept-language=en`;

    const geoOpts = {
      headers: {
        'User-Agent': 'OllamaChat-MCP-Bridge/1.0 (github.com/gardnerscot/ollamachat-mcp-bridge)',
        'Accept': 'application/json',
      },
    };
    const geoLib = https;

    geoLib.get(geoUrl, geoOpts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const geo = JSON.parse(data);
          if (!Array.isArray(geo) || geo.length === 0) {
            return resolve({
              content: [{ type: 'text', text: `Could not find location: "${query}". Try a more specific name like "Waynesboro, Pennsylvania".` }],
              isError: true,
            });
          }

          const place = geo[0];
          const latitude = parseFloat(place.lat);
          const longitude = parseFloat(place.lon);
          const displayName = place.display_name?.split(',').slice(0, 3).join(', ') || query;

          // Step 2: Fetch weather (imperial units for US)
          const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,wind_gusts_10m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=3`;

          https.get(weatherUrl, (wres) => {
            let wdata = '';
            wres.on('data', (chunk) => { wdata += chunk; });
            wres.on('end', () => {
              try {
                const w = JSON.parse(wdata);
                const c = w.current;
                const d = w.daily;

                const weatherDesc = WMO_CODES[c.weather_code] || `Code ${c.weather_code}`;
                const dailyLines = d.time.map((day, i) => {
                  const code = WMO_CODES[d.weather_code[i]] || `Code ${d.weather_code[i]}`;
                  const precip = d.precipitation_probability_max[i] != null ? `, ${d.precipitation_probability_max[i]}% precip` : '';
                  return `  ${day}: ${code}, ${Math.round(d.temperature_2m_max[i])}°F / ${Math.round(d.temperature_2m_min[i])}°F${precip}`;
                }).join('\n');

                const text = [
                  `**Weather for ${displayName}**`,
                  '',
                  `🌡️ Currently **${Math.round(c.temperature_2m)}°F** (feels like ${Math.round(c.apparent_temperature)}°F)`,
                  `💧 Humidity: ${c.relative_humidity_2m}%`,
                  `💨 Wind: ${Math.round(c.wind_speed_10m)} mph (gusts up to ${Math.round(c.wind_gusts_10m)} mph)`,
                  `🌤️ Conditions: ${weatherDesc}`,
                  '',
                  '**3-Day Forecast:**',
                  dailyLines,
                ].join('\n');

                resolve({
                  content: [{ type: 'text', text }],
                  isError: false,
                });
              } catch (err) {
                resolve({
                  content: [{ type: 'text', text: `Failed to parse weather data: ${err.message}` }],
                  isError: true,
                });
              }
            });
          }).on('error', (err) => {
            resolve({
              content: [{ type: 'text', text: `Weather API request failed: ${err.message}` }],
              isError: true,
            });
          }).setTimeout(15000, function() { this.destroy(); resolve({ content: [{ type: 'text', text: 'Weather request timed out' }], isError: true }); });

        } catch (err) {
          resolve({
            content: [{ type: 'text', text: `Failed to geocode location: ${err.message}` }],
            isError: true,
          });
        }
      });
    }).on('error', (err) => {
      resolve({
        content: [{ type: 'text', text: `Geocoding request failed: ${err.message}` }],
        isError: true,
      });
    }).setTimeout(15000, function() { this.destroy(); resolve({ content: [{ type: 'text', text: 'Geocoding request timed out' }], isError: true }); });
  });
}

function cryptoPrice(coins, currency = 'usd') {
  return new Promise((resolve) => {
    const ids = coins.toLowerCase().replace(/\s+/g, '').split(',');
    const symbolMap = {
      bitcoin: 'BTC', btc: 'BTC',
      ethereum: 'ETH', eth: 'ETH',
      solana: 'SOL', sol: 'SOL',
      cardano: 'ADA', ada: 'ADA',
      dogecoin: 'DOGE', doge: 'DOGE',
      xrp: 'XRP', ripple: 'XRP',
      polkadot: 'DOT', dot: 'DOT',
      avalanche: 'AVAX', avax: 'AVAX',
      chainlink: 'LINK', link: 'LINK',
      litecoin: 'LTC', ltc: 'LTC',
    };

    const symbols = ids.map(id => symbolMap[id] || id.toUpperCase()).filter(Boolean);
    const vs = currency.toUpperCase();

    // Fetch prices in parallel (Coinbase only does one pair at a time)
    const promises = symbols.map(sym => {
      return new Promise((resolveOne) => {
        const url = `https://api.coinbase.com/v2/prices/${sym}-${vs}/spot`;
        https.get(url, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'OllamaChat/1.0' },
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              if (res.statusCode !== 200) {
                return resolveOne({ error: `HTTP ${res.statusCode}` });
              }
              const j = JSON.parse(data);
              const amount = parseFloat(j.data?.amount || 0);
              resolveOne({ symbol: sym, price: amount, error: null });
            } catch {
              resolveOne({ error: 'parse error' });
            }
          });
        }).on('error', (err) => resolveOne({ error: err.message }))
          .setTimeout(10000, function() { this.destroy(); resolveOne({ error: 'timeout' }); });
      });
    });

    Promise.all(promises).then(results => {
      const lines = [];
      for (const r of results) {
        if (r.error) {
          lines.push(`**${r.symbol || '?'}**: Error — ${r.error}`);
        } else {
          const price = r.price;
          const formatted = price >= 1 ? `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${price.toFixed(price < 0.01 ? 6 : 4)}`;
          lines.push(`**${r.symbol}**: ${formatted} ${vs}`);
        }
      }
      if (lines.length === 0) {
        lines.push(`No prices found for "${coins}". Try: bitcoin, ethereum, solana.`);
      }
      resolve({
        content: [{ type: 'text', text: lines.join('\n') }],
        isError: false,
      });
    });
  });
}

// WMO Weather Codes → human-readable
const WMO_CODES = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Light freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snow',
  73: 'Moderate snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

function ts() {
  return new Date().toISOString();
}

class McpManager {
  constructor(config, policy) {
    /** @type {Map<string, McpProcess>} */
    this.servers = new Map();
    this._config = config || {};
    this._policy = policy || null;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async startAll() {
    const { peekabooSpawnPlan } = require('./security-policy');
    const plan = this._policy ? peekabooSpawnPlan(this._policy) : null;
    if (!plan) {
      console.warn(`[${ts()}] [manager] Peekaboo spawn skipped (disabled or empty allowlist)`);
      return;
    }
    await this._startServer('peekaboo', plan);
  }

  async _startServer(name, plan) {
    if (name !== 'peekaboo' || !plan || path.basename(plan.command || '') !== 'peekaboo') {
      console.error(`[${ts()}] [manager] Refusing to spawn server "${name}"`);
      return;
    }
    if (!Array.isArray(plan.args) || plan.args.length !== 1 || plan.args[0] !== 'mcp') {
      console.error(`[${ts()}] [manager] Refusing to spawn peekaboo with unexpected arguments`);
      return;
    }
    const proc = new McpProcess(name, {
      command: plan.command,
      args: plan.args,
      env: plan.env || {},
      stripEnv: plan.stripEnv || [],
    });
    this.servers.set(name, proc);

    proc.on('ready', () => {
      console.log(`[${ts()}] [manager] Server "${name}" is ready`);
    });

    await proc.start();
  }

  stopAll() {
    for (const [, proc] of this.servers) {
      proc.stop();
    }
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  getStatus() {
    const result = {};
    for (const [name, proc] of this.servers) {
      result[name] = proc.status;
    }
    return result;
  }

  // ─── Tools ────────────────────────────────────────────────────────────────

  /**
   * Returns the aggregated tool list in MCP format with prefixed names.
   * Each tool gets an extra "server" field for routing info.
   */
  async getTools() {
    const { toolAllowed } = require('./security-policy');
    const tools = [];

    for (const [serverName, proc] of this.servers) {
      if (serverName !== 'peekaboo') continue;
      for (const tool of proc.tools) {
        const name = `${serverName}${SERVER_PREFIX_SEP}${tool.name}`;
        if (this._policy && !toolAllowed(this._policy, name)) continue;
        tools.push({
          name,
          description: tool.description || '',
          inputSchema: tool.inputSchema || { type: 'object', properties: {} },
          server: serverName,
        });
      }
    }

    return tools;
  }

  /**
   * Returns tools in OpenAI function-calling format (for Ollama `tools` param).
   */
  async getToolsOpenAI() {
    const tools = await this.getTools();
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  // ─── Call routing ─────────────────────────────────────────────────────────

  /**
   * Route a prefixed tool call to the correct MCP server.
   * @param {string} prefixedName  e.g. "reminders__list_reminders"
   * @param {object} args
   * @returns {Promise<object>}    MCP tool result { content, isError }
   */
  async callTool(prefixedName, args) {
    const { prepareToolCall } = require('./security-policy');
    let prepared;
    try {
      prepared = prepareToolCall(this._policy, prefixedName, args || {});
    } catch (err) {
      throw err;
    }
    prefixedName = prepared.name;
    args = prepared.args;
    const bareName = prepared.bare;

    const sepIdx = prefixedName.indexOf(SERVER_PREFIX_SEP);
    const serverName = sepIdx > 0 ? prefixedName.slice(0, sepIdx) : '';
    const toolName = sepIdx > 0 ? prefixedName.slice(sepIdx + SERVER_PREFIX_SEP.length) : '';
    if (serverName !== 'peekaboo' || !toolName) throw toolDenied();

    const proc = this.servers.get(serverName);
    if (!proc) {
      const err = new Error('MCP server "peekaboo" is not connected');
      err.statusCode = 503;
      throw err;
    }
    const { presentToolResult } = require('./security-policy');
    return presentToolResult(bareName, await proc.callTool(toolName, args));
  }
}

module.exports = { McpManager, getBraveKey, setBraveKey, setOsaurusKey };
