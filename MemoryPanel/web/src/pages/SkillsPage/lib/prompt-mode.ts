/** Instance prompt mode loader. One request per key; a failed request is not cached. */
export type PromptMode = 'code' | 'chat';

export function createPromptModeLoader(fetchSettings: () => Promise<{ prompt_mode: string }>) {
  let cached: { key: string; promise: Promise<PromptMode> } | null = null;
  return function load(key: string): Promise<PromptMode> {
    if (cached && cached.key === key) return cached.promise;
    const promise = fetchSettings().then(
      (s): PromptMode => (s.prompt_mode === 'chat' ? 'chat' : 'code'),
      (): PromptMode => {
        // Show project UI when the call fails, and ask again next time.
        if (cached?.promise === promise) cached = null;
        return 'code';
      },
    );
    cached = { key, promise };
    return promise;
  };
}

/** Project UI is hidden only in chat mode. */
export function showsProjectUi(mode: PromptMode): boolean {
  return mode !== 'chat';
}
