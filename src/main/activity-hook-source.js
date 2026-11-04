// Installed under BotLogik's application data directory; no workspace/global CLI settings are edited.
export const activityHookSource = String.raw`const http = require('node:http');
let input = '';
const timer = setTimeout(() => process.exit(0), 900);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (input.length > 1024 * 1024) process.exit(0);
});
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  try {
    const port = Number(process.env.BOTLOGIK_ACTIVITY_PORT);
    const token = process.env.BOTLOGIK_ACTIVITY_TOKEN;
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{64}$/.test(token || '')) return process.exit(0);
    const event = JSON.parse(input);
    const payload = {};
    for (const key of ['hook_event_name', 'source', 'session_id', 'agent_id', 'isSidechain', 'tool_name', 'tool_use_id', 'tool_call_id', 'notification_type', 'stop_hook_active']) {
      const value = event[key];
      if (typeof value === 'string') payload[key] = value.slice(0, 256);
      else if (typeof value === 'boolean') payload[key] = value;
    }
    const body = JSON.stringify(payload);
    const request = http.request({ hostname: '127.0.0.1', port, path: '/activity', method: 'POST', headers: {
      authorization: 'Bearer ' + token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body)
    }, timeout: 600 }, response => {
      response.resume();
      response.on('end', () => { clearTimeout(timer); process.exit(0); });
    });
    request.on('timeout', () => { request.destroy(); process.exit(0); });
    request.on('error', () => process.exit(0));
    request.end(body);
  } catch { process.exit(0); }
});
`;
