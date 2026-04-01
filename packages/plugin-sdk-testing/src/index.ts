export type PluginTestHarness<TContext extends Record<string, unknown>> = {
  context: TContext;
  emit: (event: string, payload?: Record<string, unknown>) => void;
  invokeAction: (key: string, payload?: Record<string, unknown>) => Promise<unknown>;
  invokeData: (key: string, payload?: Record<string, unknown>) => Promise<unknown>;
};

export function createTestHarness<TContext extends Record<string, unknown>>(
  context: TContext,
  options?: {
    actions?: Record<string, (payload: Record<string, unknown>) => Promise<unknown> | unknown>;
    data?: Record<string, (payload: Record<string, unknown>) => Promise<unknown> | unknown>;
  }
): PluginTestHarness<TContext> {
  const actions = options?.actions ?? {};
  const dataHandlers = options?.data ?? {};
  return {
    context,
    emit: () => {
      // placeholder harness for first SDK milestone
    },
    async invokeAction(key, payload = {}) {
      const handler = actions[key];
      if (!handler) {
        throw new Error(`Missing test action handler '${key}'`);
      }
      return await handler(payload);
    },
    async invokeData(key, payload = {}) {
      const handler = dataHandlers[key];
      if (!handler) {
        throw new Error(`Missing test data handler '${key}'`);
      }
      return await handler(payload);
    }
  };
}
