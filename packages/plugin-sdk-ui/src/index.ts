export function useHostContext<T extends Record<string, unknown>>(context: T) {
  return context;
}

export function usePluginData<T>(factory: () => T): T {
  return factory();
}

export async function usePluginAction<TInput extends Record<string, unknown>, TOutput>(
  action: (input: TInput) => Promise<TOutput>,
  input: TInput
) {
  return action(input);
}
