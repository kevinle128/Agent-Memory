import type { RegisteredTool } from '../registry.js';
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from '../server-info.js';

export const NO_TEAM_MESSAGE = 'You are not an active member of any team.';

export const whoamiTool: RegisteredTool = {
  name: 'whoami',
  group: 'core',
  description:
    'Who you are in Agent-Memory: your user, the teams you are an active member of, and your role and read scope in each. Call this first.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  async run(args, access) {
    const teams = await access.scope(args.team_id);
    return {
      user_id: access.caller.userId,
      username: access.caller.username,
      user_type: access.caller.userType,
      teams,
      ...(teams.length === 0 ? { message: NO_TEAM_MESSAGE } : {}),
      groups: ['core', 'knowledge'],
      server: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    };
  },
};
