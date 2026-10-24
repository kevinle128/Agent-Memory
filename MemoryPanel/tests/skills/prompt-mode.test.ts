import { describe, expect, it, vi } from 'vitest';
import { createPromptModeLoader, showsProjectUi } from '../../web/src/pages/SkillsPage/lib/prompt-mode';

describe('prompt mode loader', () => {
  it('asks once per key and caches the answer', async () => {
    const fetchSettings = vi.fn().mockResolvedValue({ prompt_mode: 'chat' });
    const load = createPromptModeLoader(fetchSettings);
    expect(await load('inst-a')).toBe('chat');
    expect(await load('inst-a')).toBe('chat');
    expect(fetchSettings).toHaveBeenCalledTimes(1);
    await load('inst-b');
    expect(fetchSettings).toHaveBeenCalledTimes(2);
  });

  it('defaults to code mode when the call fails, and asks again next time', async () => {
    const fetchSettings = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({ prompt_mode: 'chat' });
    const load = createPromptModeLoader(fetchSettings);
    expect(await load('k')).toBe('code');
    expect(await load('k')).toBe('chat');
    expect(fetchSettings).toHaveBeenCalledTimes(2);
  });

  it('treats an unknown value as code mode', async () => {
    const load = createPromptModeLoader(async () => ({ prompt_mode: 'other' }));
    expect(await load('k')).toBe('code');
  });

  it('hides project UI only in chat mode', () => {
    expect(showsProjectUi('chat')).toBe(false);
    expect(showsProjectUi('code')).toBe(true);
  });
});
