#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read the tools data from parent directory
const toolsData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tools-generated.json'), 'utf8'));

// Generate the single-file server with modular tools
const serverCode = `#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { OPNsenseClient } from '@richard-stovall/opnsense-typescript-client';
import { createServer } from 'http';

// Embedded modular tool definitions
const TOOLS = ${JSON.stringify(toolsData.tools, null, 2)};

// Method documentation for help
const METHOD_DOCS = ${JSON.stringify(toolsData.methodDocs, null, 2)};

// Simple glob pattern matcher (supports * and ? wildcards)
function globMatch(pattern, str) {
  // Escape regex special chars except * and ?, then convert glob wildcards
  let regexPattern = pattern.replace(/[.+^$|()\\[\\]\\\\]/g, '\\\\$&');
  regexPattern = regexPattern.replace(/\\*/g, '.*').replace(/\\?/g, '.');
  const regex = new RegExp(\`^\${regexPattern}\$\`, 'i');
  return regex.test(str);
}

// Check if a tool name matches patterns (comma-separated, supports ! negation)
// Patterns are processed left-to-right, later patterns override earlier ones
// Examples:
//   "*,!plugin_*,plugin_caddy*" = all tools except plugins, but include caddy
//   "!diagnostics_*" = all tools except diagnostics
//   "firewall_*,unbound_*" = only firewall and unbound tools
function matchesPatterns(toolName, patterns) {
  if (!patterns || patterns.trim() === '') return false;
  const patternList = patterns.split(',').map(p => p.trim()).filter(p => p);

  // Helper to check if pattern is negated (handles shell escaping: ! or \\!)
  const isNegated = (p) => p.startsWith('!') || p.startsWith('\\\\!');
  const stripNegation = (p) => p.replace(/^\\\\?!/, '');

  // Check if there are any positive (non-negated) patterns
  const hasPositivePatterns = patternList.some(p => !isNegated(p));

  // If only negation patterns, start with included=true (negations filter from all)
  // If has positive patterns, start with included=false (must match a positive)
  let included = !hasPositivePatterns;

  // Process patterns left-to-right, later patterns override
  for (const pattern of patternList) {
    if (isNegated(pattern)) {
      // Negation pattern - exclude if matches
      const negPattern = stripNegation(pattern);
      if (globMatch(negPattern, toolName)) {
        included = false;
      }
    } else {
      // Positive pattern - include if matches
      if (globMatch(pattern, toolName)) {
        included = true;
      }
    }
  }

  return included;
}

class OPNsenseMCPServer {
  constructor(config) {
    this.config = config;
    this.client = null;
    this.server = new Server(
      {
        name: 'opnsense-mcp-server',
        version: '0.6.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  ensureClient() {
    if (!this.client) {
      this.client = new OPNsenseClient({
        baseUrl: this.config.url,
        apiKey: this.config.apiKey,
        apiSecret: this.config.apiSecret,
        verifySsl: this.config.verifySsl ?? true,
      });
    }
    return this.client;
  }

  setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.getAvailableTools(),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      const tool = TOOLS.find(t => t.name === name);
      if (!tool) {
        throw new McpError(ErrorCode.MethodNotFound, \`Tool \${name} not found\`);
      }

      // Check if tool is available (passes all filters)
      const availableTools = this.getAvailableTools();
      if (!availableTools.find(t => t.name === name)) {
        throw new McpError(ErrorCode.MethodNotFound, \`Tool \${name} is not available (filtered out or plugins disabled)\`);
      }

      try {
        const result = await this.callModularTool(tool, args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        console.error('Tool call error:', {
          tool: tool.name,
          module: tool.module,
          args,
          error: error instanceof Error ? error.message : 'Unknown error',
          stack: error instanceof Error ? error.stack : undefined
        });
        
        // Extract more details from axios errors
        let errorMessage = 'Unknown error';
        if (error instanceof Error) {
          errorMessage = error.message;
          if (error.response) {
            const response = error.response;
            errorMessage = \`HTTP \${response.status}: \${response.statusText}\\n\`;
            if (response.data) {
              errorMessage += \`Response: \${JSON.stringify(response.data, null, 2)}\`;
            }
          }
        }
        
        return {
          content: [{
            type: 'text',
            text: \`Error calling \${tool.name}.\${args.method || 'unknown'}: \${errorMessage}\`
          }],
        };
      }
    });
  }

  getAvailableTools() {
    return TOOLS.filter(tool => {
      // First, apply plugin filter
      if (tool.module === 'plugins' && !this.config.includePlugins) {
        return false;
      }

      // Apply include pattern filter (if set, only matching tools are included)
      if (this.config.toolsInclude) {
        if (!matchesPatterns(tool.name, this.config.toolsInclude)) {
          return false;
        }
      }

      // Apply exclude pattern filter (matching tools are excluded)
      if (this.config.toolsExclude) {
        if (matchesPatterns(tool.name, this.config.toolsExclude)) {
          return false;
        }
      }

      return true;
    }).map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }));
  }

  async callModularTool(tool, args) {
    const client = this.ensureClient();
    
    // Validate method parameter
    if (!args.method) {
      throw new Error(\`Missing required parameter 'method'. Available methods: \${tool.methods.join(', ')}\`);
    }
    
    if (!tool.methods.includes(args.method)) {
      throw new Error(\`Invalid method '\${args.method}'. Available methods: \${tool.methods.join(', ')}\`);
    }
    
    // Get the module
    let moduleObj;
    if (tool.module === 'plugins' && tool.submodule) {
      moduleObj = client.plugins[tool.submodule];
    } else {
      moduleObj = client[tool.module];
    }

    if (!moduleObj) {
      throw new Error(\`Module \${tool.module} not found\`);
    }

    // Get the method
    const method = moduleObj[args.method];
    if (!method || typeof method !== 'function') {
      throw new Error(\`Method \${args.method} not found in module \${tool.module}\`);
    }

    // Call the method with params (if provided)
    console.error(\`Calling \${tool.module}.\${args.method} with params:\`, args.params);
    
    // Extract params, excluding the method field
    const { method: _, params = {}, ...otherArgs } = args;
    const callParams = { ...params, ...otherArgs };
    
    // Only pass parameters if there are any
    if (Object.keys(callParams).length > 0) {
      return await method.call(moduleObj, callParams);
    } else {
      return await method.call(moduleObj);
    }
  }

  async start() {
    const availableTools = this.getAvailableTools();

    if (this.config.transport === 'sse') {
      await this.startSSE();
    } else {
      await this.startStdio();
    }

    console.error('OPNsense MCP server v0.6.0 (modular) started');
    console.error(\`Transport: \${this.config.transport || 'stdio'}\`);
    console.error(\`Plugins: \${this.config.includePlugins ? 'enabled' : 'disabled'}\`);
    if (this.config.toolsInclude) {
      console.error(\`Include filter: \${this.config.toolsInclude}\`);
    }
    if (this.config.toolsExclude) {
      console.error(\`Exclude filter: \${this.config.toolsExclude}\`);
    }
    console.error(\`Tools loaded: \${availableTools.length}\`);
  }

  async startStdio() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  async startSSE() {
    const port = this.config.port || 3000;
    const self = this;

    // Track active transports for cleanup
    const transports = {};

    const httpServer = createServer(async (req, res) => {
      // Enable CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url, \`http://\${req.headers.host}\`);

      // Health check endpoint
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', tools: self.getAvailableTools().length }));
        return;
      }

      // SSE endpoint - client connects here for server-to-client messages
      if (url.pathname === '/sse') {
        console.error('SSE connection established');
        const transport = new SSEServerTransport('/message', res);
        transports[transport.sessionId] = transport;

        res.on('close', () => {
          console.error('SSE connection closed');
          delete transports[transport.sessionId];
        });

        await self.server.connect(transport);
        return;
      }

      // Message endpoint - client sends messages here
      if (url.pathname === '/message' && req.method === 'POST') {
        const sessionId = url.searchParams.get('sessionId');
        const transport = transports[sessionId];

        if (!transport) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or missing sessionId' }));
          return;
        }

        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            await transport.handlePostMessage(req, res, body);
          } catch (error) {
            console.error('Error handling message:', error);
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Internal server error' }));
            }
          }
        });
        return;
      }

      // Not found
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    httpServer.listen(port, () => {
      console.error(\`SSE server listening on port \${port}\`);
      console.error(\`SSE endpoint: http://localhost:\${port}/sse\`);
      console.error(\`Message endpoint: http://localhost:\${port}/message\`);
      console.error(\`Health check: http://localhost:\${port}/health\`);
    });
  }
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    url: '',
    apiKey: '',
    apiSecret: '',
    verifySsl: true,
    includePlugins: false,
    toolsInclude: '',
    toolsExclude: '',
    transport: 'stdio',
    port: 3000,
    listTools: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--url':
      case '-u':
        config.url = args[++i];
        break;
      case '--api-key':
      case '-k':
        config.apiKey = args[++i];
        break;
      case '--api-secret':
      case '-s':
        config.apiSecret = args[++i];
        break;
      case '--no-verify-ssl':
        config.verifySsl = false;
        break;
      case '--plugins':
        config.includePlugins = true;
        break;
      case '--tools-include':
        config.toolsInclude = args[++i];
        break;
      case '--tools-exclude':
        config.toolsExclude = args[++i];
        break;
      case '--sse':
        config.transport = 'sse';
        break;
      case '--port':
      case '-p':
        config.port = parseInt(args[++i], 10);
        break;
      case '--help':
      case '-h':
        showHelp();
        process.exit(0);
        break;
      case '--list-tools':
        config.listTools = true;
        break;
    }
  }

  return config;
}

function showHelp() {
  console.log(\`
OPNsense MCP Server v0.6.0 (Modular Edition)

Usage: opnsense-mcp-server --url <url> --api-key <key> --api-secret <secret> [options]

Required:
  -u, --url <url>           OPNsense API URL (e.g., https://192.168.1.1)
  -k, --api-key <key>       API Key for authentication
  -s, --api-secret <secret> API Secret for authentication

Options:
  --no-verify-ssl           Disable SSL certificate verification
  --plugins                 Include plugin tools (adds ${toolsData.pluginTools} plugin modules)
  --tools-include <patterns> Only include tools matching patterns (comma-separated globs)
  --tools-exclude <patterns> Exclude tools matching patterns (comma-separated globs)
  --sse                     Use SSE transport instead of stdio (for Docker/remote)
  -p, --port <port>         Port for SSE server (default: 3000)
  --list-tools              List tools that would be loaded and exit (no credentials needed)
  -h, --help                Show this help message

Environment Variables:
  OPNSENSE_URL              OPNsense API URL
  OPNSENSE_API_KEY          API Key
  OPNSENSE_API_SECRET       API Secret
  OPNSENSE_VERIFY_SSL       Set to 'false' to disable SSL verification
  INCLUDE_PLUGINS           Set to 'true' to include plugin tools
  TOOLS_INCLUDE             Only include tools matching patterns (comma-separated globs)
  TOOLS_EXCLUDE             Exclude tools matching patterns (comma-separated globs)
  MCP_TRANSPORT             Set to 'sse' for SSE transport (default: stdio)
  PORT                      Port for SSE server (default: 3000)

Tool Filtering:
  Use glob patterns with * (any chars) and ? (single char) to filter tools.
  Patterns are case-insensitive and comma-separated for multiple patterns.

  Examples:
    TOOLS_INCLUDE="firewall_*"              # Only firewall tools
    TOOLS_INCLUDE="*_manage"                # All manage tools
    TOOLS_INCLUDE="firewall_*,unbound_*"    # Firewall and DNS tools
    TOOLS_EXCLUDE="plugin_*"                # Exclude all plugins
    TOOLS_INCLUDE="plugin_caddy*,plugin_nginx*"  # Only Caddy and Nginx plugins

Examples:
  # Basic usage with stdio (${toolsData.coreTools} core modules)
  opnsense-mcp-server --url https://192.168.1.1 --api-key mykey --api-secret mysecret

  # With plugins enabled (${toolsData.totalTools} total modules)
  opnsense-mcp-server --url https://192.168.1.1 --api-key mykey --api-secret mysecret --plugins

  # SSE mode for Docker/remote access
  opnsense-mcp-server --sse --port 3000 --url https://192.168.1.1 --api-key mykey --api-secret mysecret

  # Only load specific tools
  TOOLS_INCLUDE="firewall_*,unbound_*" opnsense-mcp-server --url https://192.168.1.1 ...

Tool Usage:
  Each tool represents a module and accepts a 'method' parameter to specify the operation.

  Example: firewall_manage
  - method: "aliasSearchItem" - Search firewall aliases
  - method: "aliasAddItem" - Add a new alias
  - method: "aliasSetItem" - Update an existing alias (requires uuid in params)

  Parameters are passed in the 'params' object:
  {
    "method": "aliasSearchItem",
    "params": {
      "searchPhrase": "web",
      "current": 1,
      "rowCount": 20
    }
  }

Based on @richard-stovall/opnsense-typescript-client v0.5.3
\`);
}

// List tools based on current filter configuration
function listFilteredTools(config) {
  const tools = TOOLS.filter(tool => {
    // First, apply plugin filter
    if (tool.module === 'plugins' && !config.includePlugins) {
      return false;
    }

    // Apply include pattern filter
    if (config.toolsInclude) {
      if (!matchesPatterns(tool.name, config.toolsInclude)) {
        return false;
      }
    }

    // Apply exclude pattern filter
    if (config.toolsExclude) {
      if (matchesPatterns(tool.name, config.toolsExclude)) {
        return false;
      }
    }

    return true;
  });

  console.log('\\nTool Filter Configuration:');
  console.log('  INCLUDE_PLUGINS:', config.includePlugins);
  console.log('  TOOLS_INCLUDE:', config.toolsInclude || '(not set)');
  console.log('  TOOLS_EXCLUDE:', config.toolsExclude || '(not set)');
  console.log('\\nTools that would be loaded (' + tools.length + ' total):\\n');

  // Group by type
  const coreTools = tools.filter(t => t.module !== 'plugins');
  const pluginTools = tools.filter(t => t.module === 'plugins');

  if (coreTools.length > 0) {
    console.log('Core Modules (' + coreTools.length + '):');
    coreTools.forEach(t => console.log('  - ' + t.name + ' (' + t.methods.length + ' methods)'));
  }

  if (pluginTools.length > 0) {
    console.log('\\nPlugin Modules (' + pluginTools.length + '):');
    pluginTools.forEach(t => console.log('  - ' + t.name + ' (' + t.methods.length + ' methods)'));
  }

  if (tools.length === 0) {
    console.log('  (no tools match the current filter)');
  }

  console.log('');
}

// Main entry point
async function main() {
  const config = parseArgs();

  // Use environment variables as fallback
  config.url = config.url || process.env.OPNSENSE_URL || '';
  config.apiKey = config.apiKey || process.env.OPNSENSE_API_KEY || '';
  config.apiSecret = config.apiSecret || process.env.OPNSENSE_API_SECRET || '';
  if (!config.verifySsl || process.env.OPNSENSE_VERIFY_SSL === 'false') {
    config.verifySsl = false;
  }
  if (config.includePlugins || process.env.INCLUDE_PLUGINS === 'true') {
    config.includePlugins = true;
  }
  config.toolsInclude = config.toolsInclude || process.env.TOOLS_INCLUDE || '';
  config.toolsExclude = config.toolsExclude || process.env.TOOLS_EXCLUDE || '';
  if (process.env.MCP_TRANSPORT === 'sse') {
    config.transport = 'sse';
  }
  if (process.env.PORT) {
    config.port = parseInt(process.env.PORT, 10);
  }

  // If --list-tools, show filtered tools and exit (no credentials needed)
  if (config.listTools) {
    listFilteredTools(config);
    process.exit(0);
  }

  // Validate required arguments
  if (!config.url || !config.apiKey || !config.apiSecret) {
    console.error('Error: Missing required arguments\\n');
    showHelp();
    process.exit(1);
  }

  // Create and start server
  const server = new OPNsenseMCPServer(config);
  await server.start();
}

// Run the server
main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
`;

// Write the single-file server to parent directory
fs.writeFileSync(path.join(__dirname, '..', 'index.js'), serverCode);
console.log('Built index.js successfully');
console.log(`Total tools: ${toolsData.totalTools} modules`);
console.log(`Core tools: ${toolsData.coreTools} modules`);
console.log(`Plugin tools: ${toolsData.pluginTools} modules`);