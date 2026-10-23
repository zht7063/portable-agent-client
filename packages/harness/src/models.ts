import type { ModelInfo } from '@pac/core/contract';
import type { HttpClient } from '@pac/core';

/** Only what the harness needs: the relay model list as seen by an sk key (Codex channel probe). Model UI is upstream's. */
export interface ModelsModule {
  /** Relay list with an sk key (/v1/models). */
  listWithKey(sk: string): Promise<ModelInfo[]>;
}

export function createModels(http: HttpClient): ModelsModule {
  return {
    async listWithKey(sk) {
      const d = await http.json<{ data?: { id: string }[] }>('GET', '/v1/models', { auth: { sk } });
      return (d.data ?? []).map((m) => ({ id: m.id }));
    },
  };
}
