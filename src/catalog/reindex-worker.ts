import type { EmbeddingProvider } from './domain.js';
import { catalogItemId, type MemoryAcpCatalogStore, type OutboxJob } from './ingestion.js';
import { buildAcpSearchableFields } from './projection.js';

export interface ReindexWorkerOptions {
  leaseMs?: number;
  maxAttempts?: number;
  now?: () => number;
}

export class ReindexWorker {
  private stopping = false;
  private claimed: OutboxJob | undefined;

  constructor(
    private readonly store: MemoryAcpCatalogStore,
    private readonly embedding: EmbeddingProvider,
    private readonly options: ReindexWorkerOptions = {},
  ) {}

  requestStop(): void {
    this.stopping = true;
  }

  releaseClaimed(): void {
    if (!this.claimed) return;
    this.claimed.status = 'pending';
    this.claimed.lease_until = undefined;
    this.claimed = undefined;
  }

  claimNext(): OutboxJob | undefined {
    if (this.stopping) return undefined;
    const now = this.options.now?.() ?? Date.now();
    const leaseMs = this.options.leaseMs ?? 30_000;
    const job = this.store.outbox.find((row) => {
      const until = row.lease_until ? Date.parse(row.lease_until) : 0;
      const ready = !row.lease_until || until <= now;
      return (
        (row.status === 'pending' && ready) ||
        (row.status === 'leased' && row.lease_until !== undefined && until <= now)
      );
    });
    if (!job) return undefined;
    job.status = 'leased';
    job.lease_until = new Date(now + leaseMs).toISOString();
    this.claimed = job;
    return job;
  }

  async processNext(): Promise<boolean> {
    const job = this.claimNext();
    if (!job) return false;
    try {
      await this.execute(job);
      job.status = 'done';
      job.lease_until = undefined;
      this.claimed = undefined;
      return true;
    } catch (err) {
      const maxAttempts = this.options.maxAttempts ?? 5;
      job.attempts += 1;
      job.last_error = err instanceof Error ? err.message : String(err);
      const now = this.options.now?.() ?? Date.now();
      job.lease_until =
        job.attempts >= maxAttempts
          ? undefined
          : new Date(now + Math.min(30_000, 1000 * 2 ** (job.attempts - 1))).toISOString();
      job.status = job.attempts >= maxAttempts ? 'dead_letter' : 'pending';
      this.claimed = undefined;
      return true;
    }
  }

  private async execute(job: OutboxJob): Promise<void> {
    const current = this.store.revisions.get(job.item_id);
    if (job.operation === 'delete') {
      this.store.documents.delete(job.item_id);
      return;
    }
    if (current && job.search_revision < current.search_revision) {
      return;
    }
    if (current && current.index_revision >= job.search_revision) {
      return;
    }
    const product = this.store.products.get(job.feed_id)?.get(job.external_product_id);
    const variant = product?.variants.find((row) => row.id === job.external_variant_id);
    if (!product || !variant) {
      throw new Error('variant missing for outbox job');
    }
    const fields = buildAcpSearchableFields(product, variant);
    const vectors = await this.embedding.embed([fields.search_text]);
    const embedding = vectors[0];
    if (!embedding || embedding.length !== this.embedding.dimensions) {
      throw new Error('incompatible embedding');
    }
    const latest = this.store.revisions.get(job.item_id);
    if (latest && job.search_revision < latest.search_revision) {
      return;
    }
    this.store.documents.set(job.item_id, {
      item_id: job.item_id,
      name: fields.name,
      description: fields.description,
      item_info: fields.item_info,
      search_text: fields.search_text,
      embedding,
      index_revision: job.search_revision,
    });
    if (latest) {
      this.store.revisions.set(job.item_id, { ...latest, index_revision: job.search_revision });
    }
  }
}

export function itemIdentity(feedId: string, productId: string, variantId: string): string {
  return catalogItemId(feedId, productId, variantId);
}
