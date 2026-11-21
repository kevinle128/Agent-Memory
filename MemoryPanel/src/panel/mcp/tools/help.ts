import type { RegisteredTool } from '../registry.js';
import { HELP_TOPICS, findHelpTopic } from '../help/topics.js';

function topicList(): string {
  return HELP_TOPICS.map((t) => `- ${t.id}: ${t.summary}`).join('\n');
}

export const helpTool: RegisteredTool = {
  name: 'help',
  group: 'core',
  description:
    'How Agent-Memory works. Without a topic it lists the topics. Topics: overview, memory-pipeline, access, knowledge, glossary.',
  inputSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'Topic id. Omit to list the topics.' },
    },
    required: [],
  },
  async run(args) {
    const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
    if (!topic) return { text: `Help topics:\n${topicList()}`, isError: false };
    const found = findHelpTopic(topic);
    if (!found) return { text: `Unknown topic.\n\nHelp topics:\n${topicList()}`, isError: false };
    return { text: found.text, isError: false };
  },
};
