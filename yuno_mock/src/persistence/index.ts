import type { MockConfig } from '../config.js';
import { FileYunoRepository } from './file.js';
import { InMemoryYunoRepository } from './memory.js';
import type { YunoMockRepository } from './types.js';

export type { YunoMockRepository, YunoMockStore } from './types.js';
export { emptyStore } from './types.js';
export { FileYunoRepository } from './file.js';
export { InMemoryYunoRepository } from './memory.js';

export function createRepository(config: MockConfig): YunoMockRepository {
  if (config.YUNO_STORE_BACKEND === 'file') {
    return new FileYunoRepository(config.storeFilePath, config.secretsKey);
  }
  return new InMemoryYunoRepository();
}
