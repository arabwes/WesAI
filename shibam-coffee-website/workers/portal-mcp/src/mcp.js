// The MCP server: tool names, descriptions and input checks that an AI app sees. Every tool is
// read-only; the work happens in tools.js.
import { McpServer } from '@modelcontextprotocol/server';
import { getMcpAuthContext } from 'agents/mcp/server';
import { z } from 'zod';
import { runTool, toToolError } from './tools.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function ok(data) {
  return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function failure(error) {
  const problem = toToolError(error);
  return {
    isError: true,
    structuredContent: { ok: false, error: problem.code, message: problem.message },
    content: [{ type: 'text', text: `${problem.code}: ${problem.message}` }]
  };
}

function connection() {
  const props = getMcpAuthContext()?.props || {};
  return { userId: typeof props.userId === 'string' ? props.userId : '', clientName: typeof props.clientName === 'string' ? props.clientName : '' };
}

const TOOL_DEFINITIONS = [
  ['portal_whoami', 'Who am I connected as', 'Shows which portal account this connection uses, its role, and exactly what this read-only connector can and cannot see.', z.object({})],
  ['inventory_latest_count', 'Latest inventory count',
    'The most recent submitted weekly inventory count: every item with kitchen, storage and total quantities, and whether it is below its "order below" level. Also says whether a new count is in progress. Use only_below_threshold for a shopping/reorder list.',
    z.object({
      only_below_threshold: z.boolean().default(false).describe('Only items whose total is below their order-below level'),
      section: z.string().max(80).default('').describe('Only items in sections whose name contains this text, e.g. "walk-in"')
    })],
  ['schedule_week', 'Weekly schedule',
    'The shift schedule for one Monday-to-Sunday week: who works when, positions, open shifts, whether it is published, and who has time off (never the reason). Defaults to the current week.',
    z.object({ week_start: date.optional().describe('Any date in the week wanted, e.g. 2026-11-16') })],
  ['team_calendar', 'Team calendar',
    'Team events and booked meetings between two dates (at most 100 days). Other people\'s meetings appear only as "Booked". Invitee names and contact details are never included.',
    z.object({ from: date.describe('First day, e.g. 2026-11-01'), to: date.describe('Last day, e.g. 2026-11-30') })],
  ['catering_requests', 'Catering requests',
    'Catering and event quote requests with their status, event details, message counts and unread replies. Customer names, emails and phone numbers are not included.',
    z.object({
      status: z.enum(['new', 'reviewed', 'closed']).optional().describe('Only requests with this status'),
      limit: z.number().int().min(1).max(100).default(25)
    })],
  ['catering_conversation', 'Catering conversation',
    'The messages between the team and the customer for one catering request (from catering_requests), including the team\'s internal notes. Reading here does not mark replies as read in the portal.',
    z.object({ request_id: z.string().min(1).max(100).describe('The id from catering_requests') })],
  ['meeting_types', 'Meeting types and booking links',
    'Your meeting types (Management sees everyone\'s) with their booking links\' status and booking counts. The private link addresses are not included; copy them from the portal.',
    z.object({})]
];

export function createPortalMcpServer(env) {
  const server = new McpServer({ name: 'Shibam Coffee Portal', version: '1.0.0' });
  for (const [name, title, description, inputSchema] of TOOL_DEFINITIONS) {
    server.registerTool(name, { title, description, inputSchema, annotations: READ_ONLY }, async (input) => {
      try {
        return ok(await runTool(env, connection(), name, input || {}));
      } catch (error) {
        return failure(error);
      }
    });
  }
  return server;
}

export const TOOL_NAMES = TOOL_DEFINITIONS.map(([name]) => name);
